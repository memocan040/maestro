use chrono::Utc;
use maestro_protocol::{BranchMode, CreateTaskRequest, TaskStatus, WorkspaceMode};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

static WAKE: std::sync::OnceLock<tokio::sync::mpsc::Sender<()>> = std::sync::OnceLock::new();

pub fn notifications() -> tokio::sync::mpsc::Receiver<()> {
    let (tx, rx) = tokio::sync::mpsc::channel(1);
    if WAKE.set(tx).is_err() {
        crate::send_diag("warn", "Orchestration notification channel already exists");
    }
    rx
}

pub fn notify() {
    if let Some(tx) = WAKE.get() {
        match tx.try_send(()) {
            Ok(()) | Err(tokio::sync::mpsc::error::TrySendError::Full(_)) => {}
            Err(e) => crate::send_diag("warn", format!("Orchestration notification failed: {e}")),
        }
    }
}

pub const V10_ORCHESTRATION: &str = "
CREATE TABLE agent_team (
    project_path TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(project_path, id)
);
CREATE TABLE features (
    project_path TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(project_path, id)
);
CREATE TABLE feature_tasks (
    project_path TEXT NOT NULL, feature_id TEXT NOT NULL, task_id INTEGER NOT NULL,
    member_id TEXT NOT NULL, task_key TEXT NOT NULL,
    PRIMARY KEY(project_path, task_id), UNIQUE(project_path, feature_id, task_key),
    FOREIGN KEY(project_path, feature_id) REFERENCES features(project_path, id),
    FOREIGN KEY(project_path, task_id) REFERENCES tasks(project_path, id)
);
CREATE TABLE orchestration_messages (
    id TEXT PRIMARY KEY, project_path TEXT NOT NULL, feature_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL, sender_task INTEGER, recipient_task INTEGER NOT NULL,
    kind TEXT NOT NULL, body TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'Pending',
    created_at TEXT NOT NULL, UNIQUE(project_path, feature_id, dedupe_key),
    FOREIGN KEY(project_path, feature_id) REFERENCES features(project_path, id)
);
";

pub use maestro_protocol::{Feature, OrchestrationOperation as Operation, PlannedTask, TeamMember};

pub const V11_FEATURE_INTEGRATIONS: &str = "
CREATE TABLE feature_integrations (
    project_path TEXT NOT NULL, task_id INTEGER NOT NULL,
    feature_id TEXT NOT NULL, commit_sha TEXT NOT NULL, approved_at TEXT NOT NULL,
    PRIMARY KEY(project_path,task_id),
    FOREIGN KEY(project_path,task_id) REFERENCES feature_tasks(project_path,task_id)
);
";

fn decode<T: serde::de::DeserializeOwned>(text: String) -> Result<T, String> {
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

fn bodies<T: serde::de::DeserializeOwned>(
    conn: &Connection,
    table: &str,
    project: &str,
) -> Result<Vec<T>, String> {
    let mut stmt = conn
        .prepare(&format!(
            "SELECT body FROM {table} WHERE project_path = ?1 ORDER BY rowid"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([project], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| decode(r.map_err(|e| e.to_string())?))
        .collect()
}

pub fn features(conn: &Connection, project: &str) -> Result<Vec<Feature>, String> {
    bodies(conn, "features", project)
}

fn feature(conn: &Connection, project: &str, id: &str) -> Result<Feature, String> {
    let body = conn
        .query_row(
            "SELECT body FROM features WHERE project_path = ?1 AND id = ?2",
            params![project, id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "Feature not found in this project".to_string())?;
    decode(body)
}

fn save_feature(conn: &Connection, project: &str, feature: &Feature) -> Result<(), String> {
    conn.execute(
        "INSERT INTO features(project_path, id, body) VALUES (?1, ?2, ?3)
        ON CONFLICT(project_path, id) DO UPDATE SET body = excluded.body",
        params![
            project,
            feature.id,
            serde_json::to_string(feature).map_err(|e| e.to_string())?
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn member(conn: &Connection, project: &str, id: &str) -> Result<TeamMember, String> {
    let body = conn
        .query_row(
            "SELECT body FROM agent_team WHERE project_path = ?1 AND id = ?2",
            params![project, id],
            |r| r.get::<_, String>(0),
        )
        .map_err(|_| "Team member not found".to_string())?;
    let member: TeamMember = decode(body)?;
    if !member.enabled {
        return Err(format!("Team member {} is disabled", member.name));
    }
    Ok(member)
}

fn profile(project: &str, member: &TeamMember) -> Result<crate::profiles::AgentProfile, String> {
    crate::profiles::read_profiles(project)
        .profiles
        .into_iter()
        .find(|p| p.id == member.profile_id)
        .ok_or_else(|| format!("Profile {} no longer exists", member.profile_id))
}

pub fn orchestrator_for(
    conn: &Connection,
    project: &str,
    task: i32,
) -> Result<Option<Feature>, String> {
    Ok(features(conn, project)?
        .into_iter()
        .find(|f| f.orchestrator_task == task))
}

pub fn feature_for_task(
    conn: &Connection,
    project: &str,
    task: i32,
) -> Result<Option<Feature>, String> {
    let id: Option<String> = conn
        .query_row(
            "SELECT feature_id FROM feature_tasks WHERE project_path = ?1 AND task_id = ?2",
            params![project, task],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    id.map(|id| feature(conn, project, &id)).transpose()
}

pub fn check_start(conn: &Connection, project: &str, task: i32) -> Result<(), String> {
    if let Some(f) = orchestrator_for(conn, project, task)? {
        if matches!(f.status.as_str(), "Paused" | "Cancelled" | "Completed") {
            return Err(format!("Feature is {}", f.status));
        }
    }
    if let Some(f) = feature_for_task(conn, project, task)? {
        if f.status != "Running" {
            return Err(format!("Feature is {}", f.status));
        }
        let active: i64 = conn.query_row("SELECT COUNT(*) FROM feature_tasks f JOIN tasks t ON t.project_path = f.project_path AND t.id = f.task_id
            WHERE f.project_path = ?1 AND f.feature_id = ?2 AND t.id != ?3 AND t.phase_status IN ('Running', 'Blocked')", params![project, f.id, task], |r| r.get(0)).map_err(|e| e.to_string())?;
        if active >= f.max_parallel as i64 {
            return Err("Feature parallelism limit reached".into());
        }
    }
    if let Some(m) = execution_member(conn, project, task)? {
        let mut active = 0;
        for other in crate::task_store::list(conn, project)? {
            if other.id != task
                && matches!(
                    other.phase_status,
                    Some(
                        maestro_protocol::PhaseStatus::Running
                            | maestro_protocol::PhaseStatus::Blocked
                    )
                )
                && execution_member(conn, project, other.id)?
                    .is_some_and(|other| other.profile_id == m.profile_id)
            {
                active += 1;
            }
        }
        if active >= m.max_sessions {
            return Err("Team member session limit reached".into());
        }
    }
    Ok(())
}

/// A review consumes its selected reviewer's capacity, including while spawning.
/// The orchestrator also consumes the capacity of its team profile.
fn execution_member(
    conn: &Connection,
    project: &str,
    task: i32,
) -> Result<Option<TeamMember>, String> {
    if let Some(f) = orchestrator_for(conn, project, task)? {
        return member(conn, project, &f.orchestrator_member).map(Some);
    }
    let Some(f) = feature_for_task(conn, project, task)? else {
        return Ok(None);
    };
    let state = crate::task_store::transition::read_state(conn, project, task)?;
    let phase = if state.phase == Some(maestro_protocol::TaskPhase::Spawning) {
        state.claimed_from
    } else {
        state.phase
    };
    if phase == Some(maestro_protocol::TaskPhase::SelfReview) {
        let task = crate::task_store::get(conn, project, task)?.ok_or("Task not found")?;
        let profile_id =
            crate::profiles::profile_id_for(&task, maestro_protocol::AgentRole::Reviewer);
        return bodies::<TeamMember>(conn, "agent_team", project)?
            .into_iter()
            .find(|m| {
                m.enabled
                    && m.reviewer
                    && f.allowed_members.contains(&m.id)
                    && Some(&m.profile_id) == profile_id.as_ref()
            })
            .map(Some)
            .ok_or_else(|| "Feature has no enabled team reviewer for this stage".into());
    }
    let id: String = conn
        .query_row(
            "SELECT member_id FROM feature_tasks WHERE project_path = ?1 AND task_id = ?2",
            params![project, task],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    member(conn, project, &id).map(Some)
}

fn create_task(
    conn: &Connection,
    project: &str,
    title: &str,
    instructions: &str,
    branch: &str,
    agent: &str,
) -> Result<i32, String> {
    Ok(crate::task_store::create_in_transaction(
        conn,
        &CreateTaskRequest {
            project_path: project.into(),
            title: title.into(),
            description: Some(instructions.into()),
            base_branch: branch.into(),
            agent_id: Some(agent.into()),
            priority: None,
            skills: vec![],
            labels: vec![],
            auto_approve: false,
            workspace_mode: WorkspaceMode::NewWorktree,
            workspace_worktree_id: None,
            workspace_branch_mode: BranchMode::Create,
            workspace_branch: None,
            model_override: None,
        },
    )?
    .id)
}

fn validate_plan(
    conn: &Connection,
    project: &str,
    f: &Feature,
    tasks: &[PlannedTask],
) -> Result<(), String> {
    if tasks.is_empty() || tasks.len() > 100 {
        return Err("Plan must contain 1-100 tasks".into());
    }
    let mut keys = std::collections::HashSet::new();
    for t in tasks {
        if t.key.is_empty() || !keys.insert(t.key.clone()) {
            return Err("Task keys must be unique and nonempty".into());
        }
        if !(3..=255).contains(&t.title.trim().len())
            || t.instructions.trim().is_empty()
            || t.acceptance.is_empty()
        {
            return Err("Each task needs a title, instructions and acceptance criteria".into());
        }
        let m = member(conn, project, &t.member_id)?;
        if !m.worker || !f.allowed_members.contains(&t.member_id) {
            return Err("Task assigned to a disallowed worker".into());
        }
        profile(project, &m)?;
    }
    fn visit(
        key: &str,
        tasks: &[PlannedTask],
        visiting: &mut std::collections::HashSet<String>,
        done: &mut std::collections::HashSet<String>,
    ) -> Result<(), String> {
        if done.contains(key) {
            return Ok(());
        }
        if !visiting.insert(key.into()) {
            return Err("Cyclic feature plan".into());
        }
        let task = tasks
            .iter()
            .find(|t| t.key == key)
            .ok_or("Unknown task dependency")?;
        for dep in &task.depends_on {
            visit(dep, tasks, visiting, done)?;
        }
        visiting.remove(key);
        done.insert(key.into());
        Ok(())
    }
    let mut done = std::collections::HashSet::new();
    for t in tasks {
        visit(
            &t.key,
            tasks,
            &mut std::collections::HashSet::new(),
            &mut done,
        )?;
    }
    Ok(())
}

pub fn snapshot(conn: &Connection, project: &str) -> Result<Value, String> {
    let mut stmt = conn.prepare("SELECT id, feature_id, sender_task, recipient_task, kind, body, state, created_at FROM orchestration_messages WHERE project_path = ?1 ORDER BY rowid").map_err(|e| e.to_string())?;
    let messages = stmt.query_map([project], |r| Ok(json!({"id": r.get::<_,String>(0)?, "feature_id":r.get::<_,String>(1)?, "sender_task":r.get::<_,Option<i32>>(2)?, "recipient_task":r.get::<_,i32>(3)?, "kind":r.get::<_,String>(4)?, "body":r.get::<_,String>(5)?, "state":r.get::<_,String>(6)?, "created_at":r.get::<_,String>(7)?})))
        .map_err(|e| e.to_string())?.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())?;
    Ok(
        json!({"members":bodies::<TeamMember>(conn,"agent_team",project)?,"features":features(conn,project)?,"messages":messages}),
    )
}

fn actor_snapshot(conn: &Connection, project: &str, actor: Option<i32>) -> Result<Value, String> {
    let mut value = snapshot(conn, project)?;
    if let Some(task) = actor {
        let orchestrator = orchestrator_for(conn, project, task)?;
        let f = orchestrator
            .clone()
            .or(feature_for_task(conn, project, task)?)
            .ok_or("This task is not assigned to a feature")?;
        if let Some(features) = value["features"].as_array_mut() {
            features.retain(|entry| entry["id"] == f.id);
        }
        if let Some(messages) = value["messages"].as_array_mut() {
            messages.retain(|entry| {
                entry["feature_id"] == f.id
                    && (orchestrator.is_some()
                        || entry["sender_task"].as_i64() == Some(task as i64)
                        || entry["recipient_task"].as_i64() == Some(task as i64))
            });
        }
        if let Some(members) = value["members"].as_array_mut() {
            members.retain(|entry| {
                entry["id"].as_str().is_some_and(|id| {
                    f.allowed_members.iter().any(|allowed| allowed == id)
                        || id == f.orchestrator_member
                })
            });
        }
    }
    Ok(value)
}

// None is the desktop user. MCP callers always supply their bound task identity.
pub fn answer(
    conn: &mut Connection,
    project: &str,
    operation: Operation,
    actor: Option<i32>,
) -> Result<Value, String> {
    if matches!(operation, Operation::Snapshot) {
        return actor_snapshot(conn, project, actor);
    }
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    match operation {
        Operation::Snapshot => unreachable!(),
        Operation::SaveMember { member: m } => {
            if actor.is_some() {
                return Err("Only the user can edit the team".into());
            }
            if m.id.is_empty() || m.name.trim().is_empty() || !(1..=16).contains(&m.max_sessions) {
                return Err("Invalid team member or session limit".into());
            }
            profile(project, &m)?;
            tx.execute("INSERT INTO agent_team(project_path,id,body) VALUES (?1,?2,?3) ON CONFLICT(project_path,id) DO UPDATE SET body=excluded.body", params![project,m.id,serde_json::to_string(&m).map_err(|e| e.to_string())?]).map_err(|e| e.to_string())?;
        }
        Operation::CreateFeature {
            title,
            goal,
            acceptance,
            orchestrator_member,
            allowed_members,
            max_parallel,
            base_branch,
        } => {
            if actor.is_some() {
                return Err("Only the user can create a feature".into());
            }
            if title.trim().len() < 3
                || title.len() > 220
                || goal.trim().is_empty()
                || acceptance.is_empty()
                || !(1..=16).contains(&max_parallel)
                || base_branch.starts_with('-')
                || base_branch.is_empty()
            {
                return Err("Invalid feature fields".into());
            }
            let m = member(&tx, project, &orchestrator_member)?;
            if !m.orchestrator {
                return Err("Member cannot orchestrate".into());
            }
            let p = profile(project, &m)?;
            let id = uuid::Uuid::new_v4().to_string();
            let orchestrator_task = create_task(
                &tx,
                project,
                &format!("Orchestrate: {title}"),
                &goal,
                &base_branch,
                &p.agent_id,
            )?;
            let overrides = json!({"Planner":p.id,"Reviewer":null}).to_string();
            tx.execute(
                "UPDATE tasks SET profile_overrides = ?1 WHERE project_path = ?2 AND id = ?3",
                params![overrides, project, orchestrator_task],
            )
            .map_err(|e| e.to_string())?;
            save_feature(
                &tx,
                project,
                &Feature {
                    integration_branch: format!("codex/feature-{id}"),
                    id,
                    title,
                    goal,
                    acceptance,
                    orchestrator_member,
                    orchestrator_task,
                    allowed_members,
                    max_parallel,
                    base_branch,
                    status: "Planning".into(),
                    plan: vec![],
                    task_ids: vec![],
                    created_at: Utc::now().to_rfc3339(),
                },
            )?;
        }
        Operation::SubmitPlan { feature_id, tasks } => {
            let mut f = feature(&tx, project, &feature_id)?;
            if actor.is_some_and(|a| a != f.orchestrator_task) {
                return Err("Only the feature orchestrator can submit its plan".into());
            }
            if !matches!(f.status.as_str(), "Planning" | "AwaitingApproval") {
                return Err("An executing plan cannot be replaced".into());
            }
            validate_plan(&tx, project, &f, &tasks)?;
            f.plan = tasks;
            f.status = "AwaitingApproval".into();
            save_feature(&tx, project, &f)?;
        }
        Operation::ApprovePlan { feature_id } => {
            if actor.is_some() {
                return Err("Plan approval requires the user".into());
            }
            let mut f = feature(&tx, project, &feature_id)?;
            if f.status == "Running" && !f.task_ids.is_empty() {
                return snapshot(&tx, project);
            }
            if f.status != "AwaitingApproval" {
                return Err("Feature has no plan awaiting approval".into());
            }
            validate_plan(&tx, project, &f, &f.plan)?;
            let mut ids = std::collections::HashMap::new();
            for t in &f.plan {
                let m = member(&tx, project, &t.member_id)?;
                let p = profile(project, &m)?;
                let instructions = format!(
                    "{}\n\nAcceptance criteria:\n{}\n\nFeature goal: {}",
                    t.instructions,
                    t.acceptance.join("\n"),
                    f.goal
                );
                let task = create_task(
                    &tx,
                    project,
                    &t.title,
                    &instructions,
                    &f.integration_branch,
                    &p.agent_id,
                )?;
                let mut reviewers = bodies::<TeamMember>(&tx, "agent_team", project)?
                    .into_iter()
                    .filter(|r| {
                        r.enabled && r.reviewer && r.id != m.id && f.allowed_members.contains(&r.id)
                    })
                    .filter_map(|r| profile(project, &r).ok().map(|rp| (r, rp)))
                    .filter(|(_, rp)| rp.id != p.id)
                    .collect::<Vec<_>>();
                reviewers.sort_by_key(|(r, rp)| {
                    (
                        rp.agent_id == p.agent_id,
                        std::cmp::Reverse(r.priority),
                        r.id.clone(),
                    )
                });
                let reviewer_profile = reviewers.first().map(|(_, rp)| rp.id.as_str());
                let overrides =
                    json!({"Planner":null,"Coder":p.id,"Reviewer":reviewer_profile}).to_string();
                tx.execute("UPDATE tasks SET status='Queue', execute_requested_at=?1, profile_overrides=?2 WHERE project_path=?3 AND id=?4",params![Utc::now().to_rfc3339(),overrides,project,task]).map_err(|e|e.to_string())?;
                tx.execute("INSERT INTO feature_tasks(project_path,feature_id,task_id,member_id,task_key) VALUES(?1,?2,?3,?4,?5)",params![project,f.id,task,m.id,t.key]).map_err(|e|e.to_string())?;
                ids.insert(t.key.clone(), task);
                f.task_ids.push(task);
            }
            for t in &f.plan {
                for dep in &t.depends_on {
                    crate::task_store::add_relationship(
                        &tx,
                        project,
                        ids[dep],
                        ids[&t.key],
                        "blocks",
                    )?;
                }
            }
            f.status = "Running".into();
            save_feature(&tx, project, &f)?;
        }
        Operation::Control {
            feature_id,
            command,
        } => {
            if actor.is_some() {
                return Err("Run controls require the user".into());
            }
            let mut f = feature(&tx, project, &feature_id)?;
            f.status = match (command.as_str(), f.status.as_str()) {
                ("pause", "Running" | "Blocked") => "Paused",
                ("resume", "Paused" | "Blocked") => {
                    if f.task_ids.is_empty() {
                        "Planning"
                    } else {
                        "Running"
                    }
                }
                ("cancel", s) if s != "Completed" => "Cancelled",
                ("complete", "Running") => {
                    if f.task_ids.is_empty() {
                        return Err("Feature has no completed work".into());
                    }
                    for id in &f.task_ids {
                        let t = crate::task_store::get(&tx, project, *id)?
                            .ok_or("Missing feature task")?;
                        let integrated: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM feature_integrations WHERE project_path=?1 AND task_id=?2)",params![project,id],|r|r.get(0)).map_err(|e|e.to_string())?;
                        if !integrated || t.status != TaskStatus::Done
                            || !matches!(
                                t.completion,
                                Some(
                                    maestro_protocol::TaskCompletion::Merged
                                        | maestro_protocol::TaskCompletion::MergedViaPR
                                )
                            )
                        {
                            return Err("Every task must be approved and completed first".into());
                        }
                    }
                    "Completed"
                }
                _ => return Err("Invalid feature control transition".into()),
            }
            .into();
            if command == "cancel" {
                for id in f
                    .task_ids
                    .iter()
                    .chain(std::iter::once(&f.orchestrator_task))
                {
                    crate::task_store::transition::apply(
                        &tx,
                        project,
                        *id,
                        maestro_protocol::TaskTransition::Stopped,
                        &maestro_protocol::TransitionGuard::Active,
                    )?;
                }
            }
            save_feature(&tx, project, &f)?;
        }
        Operation::Message {
            feature_id,
            recipient_task,
            kind,
            body,
            dedupe_key,
        } => {
            let f = feature(&tx, project, &feature_id)?;
            if matches!(f.status.as_str(), "Completed" | "Cancelled") {
                return Err("Feature is no longer active".into());
            }
            if body.trim().is_empty()
                || body.len() > 16384
                || dedupe_key.is_empty()
                || dedupe_key.len() > 200
                || ![
                    "question",
                    "answer",
                    "progress",
                    "blocked",
                    "review_ready",
                    "review_feedback",
                    "instruction",
                ]
                .contains(&kind.as_str())
            {
                return Err("Invalid message".into());
            }
            let recipient = recipient_task.unwrap_or(f.orchestrator_task);
            if recipient != f.orchestrator_task && !f.task_ids.contains(&recipient) {
                return Err("Recipient is outside this feature".into());
            }
            if let Some(sender) = actor {
                if sender != f.orchestrator_task
                    && (!f.task_ids.contains(&sender) || recipient != f.orchestrator_task)
                {
                    return Err("Workers communicate through their feature orchestrator".into());
                }
            }
            tx.execute("INSERT INTO orchestration_messages(id,project_path,feature_id,dedupe_key,sender_task,recipient_task,kind,body,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9) ON CONFLICT(project_path,feature_id,dedupe_key) DO NOTHING",params![uuid::Uuid::new_v4().to_string(),project,feature_id,dedupe_key,actor,recipient,kind,body,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
        }
        Operation::Acknowledge { message_id } => {
            let recipient: i32=tx.query_row("SELECT recipient_task FROM orchestration_messages WHERE project_path=?1 AND id=?2",params![project,message_id],|r|r.get(0)).map_err(|_|"Message not found".to_string())?;
            if actor != Some(recipient) {
                return Err("Only the recipient can acknowledge a message".into());
            }
            tx.execute("UPDATE orchestration_messages SET state='Acknowledged' WHERE project_path=?1 AND id=?2",params![project,message_id]).map_err(|e|e.to_string())?;
        }
        Operation::RecordIntegration {
            task_id,
            commit_sha,
        } => {
            if actor.is_some() {
                return Err("Integration requires human approval".into());
            }
            let f = feature_for_task(&tx, project, task_id)?
                .ok_or("Task is not assigned to a feature")?;
            if commit_sha.len() < 40 || !commit_sha.bytes().all(|c| c.is_ascii_hexdigit()) {
                return Err("Invalid integration commit".into());
            }
            tx.execute("INSERT INTO feature_integrations(project_path,task_id,feature_id,commit_sha,approved_at) VALUES(?1,?2,?3,?4,?5) ON CONFLICT(project_path,task_id) DO UPDATE SET commit_sha=excluded.commit_sha,approved_at=excluded.approved_at",params![project,task_id,f.id,commit_sha,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
        }
        Operation::RetryMessage { message_id } => {
            if actor.is_some() {
                return Err("Only the user may retry uncertain delivery".into());
            }
            tx.execute("UPDATE orchestration_messages SET state='Pending' WHERE project_path=?1 AND id=?2 AND state='Submitted'",params![project,message_id]).map_err(|e|e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    actor_snapshot(conn, project, actor)
}

pub fn task_event(
    conn: &Connection,
    project: &str,
    task: &maestro_protocol::Task,
    summary: &str,
) -> Result<(), String> {
    let Some(f) = feature_for_task(conn, project, task.id)? else {
        return Ok(());
    };
    if matches!(f.status.as_str(), "Completed" | "Cancelled") {
        return Ok(());
    }
    let body = format!(
        "Task #{} {}: {:?} / {:?} / {:?}. Summary: {}",
        task.id, task.title, task.status, task.phase, task.phase_status, summary
    );
    conn.execute("INSERT INTO orchestration_messages(id,project_path,feature_id,dedupe_key,sender_task,recipient_task,kind,body,created_at) VALUES(?1,?2,?3,?4,?5,?6,'progress',?7,?8) ON CONFLICT(project_path,feature_id,dedupe_key) DO NOTHING",
        params![uuid::Uuid::new_v4().to_string(),project,f.id,format!("turn:{}:{}",task.id,task.updated_at),task.id,f.orchestrator_task,body,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    notify();
    Ok(())
}

pub async fn verify_workspace_basis(
    store: &crate::project_store::Store,
    project: &str,
    task: i32,
    cwd: &str,
) -> Result<(), String> {
    let required_commits = {
        let conn = store.lock().await;
        if feature_for_task(&conn, project, task)?.is_some() {
            let mut stmt = conn.prepare("SELECT i.commit_sha FROM task_relationships r JOIN feature_integrations i ON i.project_path=r.project_path AND i.task_id=r.from_task_id WHERE r.project_path=?1 AND r.to_task_id=?2 AND r.relationship_type='blocks'").map_err(|e|e.to_string())?;
            let rows = stmt
                .query_map(params![project, task], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?;
            rows.collect::<Result<Vec<_>, _>>()
                .map_err(|e| e.to_string())?
        } else {
            Vec::new()
        }
    };
    for commit in required_commits {
        crate::worktree::git(cwd, &["merge-base", "--is-ancestor", &commit, "HEAD"]).await
            .map_err(|_| format!("Dependency integration {commit} is missing from this worktree. Update its basis before retrying; existing changes have been preserved."))?;
    }
    Ok(())
}

pub async fn request(
    store: &crate::project_store::Store,
    project: &str,
    value: Value,
    actor: Option<i32>,
) -> Result<Value, String> {
    let operation: Operation = serde_json::from_value(value).map_err(|e| e.to_string())?;
    if let Operation::RecordIntegration {
        task_id,
        commit_sha,
    } = &operation
    {
        if actor.is_some() {
            return Err("Integration requires human approval".into());
        }
        let f = feature_for_task(&*store.lock().await, project, *task_id)?
            .ok_or("Task is not assigned to a feature")?;
        if commit_sha.len() < 40 || !commit_sha.bytes().all(|c| c.is_ascii_hexdigit()) {
            return Err("Invalid integration commit".into());
        }
        crate::worktree::git(
            project,
            &[
                "merge-base",
                "--is-ancestor",
                commit_sha,
                &format!("refs/heads/{}", f.integration_branch),
            ],
        )
        .await
        .map_err(|_| "Integration commit is not present in the feature branch".to_string())?;
    }
    if let Operation::ApprovePlan { feature_id } = &operation {
        if actor.is_some() {
            return Err("Plan approval requires the user".into());
        }
        let f = feature(&*store.lock().await, project, feature_id)?;
        if !matches!(f.status.as_str(), "AwaitingApproval" | "Running") {
            return Err("Feature has no approved plan".into());
        }
        if crate::worktree::git(
            project,
            &[
                "show-ref",
                "--verify",
                &format!("refs/heads/{}", f.integration_branch),
            ],
        )
        .await
        .is_err()
        {
            crate::worktree::git(project, &["branch", &f.integration_branch, &f.base_branch])
                .await?;
        }
    }
    let result = answer(&mut *store.lock().await, project, operation, actor);
    if result.is_ok() {
        notify();
    }
    result
}

pub fn prompt(conn: &Connection, project: &str, task: i32) -> Result<Option<String>, String> {
    let Some(f) = orchestrator_for(conn, project, task)? else {
        return Ok(None);
    };
    let team = bodies::<TeamMember>(conn, "agent_team", project)?;
    Ok(Some(format!("You are the persistent project orchestrator for feature {}. Do not implement code. Analyze the project and coordinate its existing tasks. Submit a structured plan through submit_feature_plan with feature_id and tasks (key, title, instructions, acceptance, member_id, depends_on). Human plan approval starts workers. Worker integration always requires human approval. Use send_feature_message to resolve specific worker questions, and acknowledge_feature_message after processing each delivered message. Do not duplicate completed or existing tasks. No polling or recursive discussions. Feature: {}\nTeam: {}",f.id,serde_json::to_string(&f).map_err(|e|e.to_string())?,serde_json::to_string(&team).map_err(|e|e.to_string())?)))
}

pub fn worker_context(
    conn: &Connection,
    project: &str,
    task: i32,
) -> Result<Option<String>, String> {
    let Some(f) = feature_for_task(conn, project, task)? else {
        return Ok(None);
    };
    Ok(Some(format!(
        "## Feature coordination\nFeature ID: {}\nGoal: {}\nAcceptance: {}\nYour task ID: {}. The orchestrator task is {}. Report progress, questions, blockers and review feedback with send_feature_message (feature_id above, recipient_task omitted, kind, body and a stable dedupe_key). Identity comes from your session; do not impersonate another task. Acknowledge delivered messages with acknowledge_feature_message. For a question or blocker, omit the completion marker and wait for the orchestrator's answer in this same session. Do not poll, delegate tasks, contact other workers, or integrate branches. Human approval is required for every integration.",
        f.id, f.goal, f.acceptance.join("; "), task, f.orchestrator_task
    )))
}

pub async fn pump(
    store: &crate::project_store::Store,
    sessions: &crate::sessions::SessionMap,
) -> Result<Vec<String>, String> {
    let conn = store.lock().await;
    let mut close = Vec::new();
    let mut stmt = conn
        .prepare("SELECT DISTINCT project_path FROM features")
        .map_err(|e| e.to_string())?;
    let projects = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for project in projects {
        for f in features(&conn, &project)? {
            for (sid, session) in sessions {
                let Some(binding) = &session.project else {
                    continue;
                };
                if binding.project_path != project {
                    continue;
                }
                let Some(task) = binding.meta.task_id else {
                    continue;
                };
                if task != f.orchestrator_task && !f.task_ids.contains(&task) {
                    continue;
                }
                if matches!(f.status.as_str(), "Cancelled" | "Completed") {
                    close.push(sid.clone());
                    continue;
                }
                if f.status == "Paused" {
                    if session
                        .turn_active
                        .load(std::sync::atomic::Ordering::SeqCst)
                    {
                        session
                            .cmd_tx
                            .try_send(crate::sessions::SessionCommand::CancelTurn)
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                if session
                    .turn_active
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    continue;
                }
                if task != f.orchestrator_task {
                    let Some(t) = crate::task_store::get(&conn, &project, task)? else {
                        continue;
                    };
                    if !matches!(
                        t.phase,
                        Some(
                            maestro_protocol::TaskPhase::Implementing
                                | maestro_protocol::TaskPhase::Rework
                        )
                    ) {
                        continue;
                    }
                    if crate::task_turn::role_of(session)
                        != Some(maestro_protocol::AgentRole::Coder)
                    {
                        continue;
                    }
                }
                let mut messages = conn.prepare("SELECT id,kind,body FROM orchestration_messages WHERE project_path=?1 AND feature_id=?2 AND recipient_task=?3 AND state='Pending' ORDER BY rowid LIMIT 8").map_err(|e|e.to_string())?;
                let rows = messages
                    .query_map(params![project, f.id, task], |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                        ))
                    })
                    .map_err(|e| e.to_string())?
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|e| e.to_string())?;
                if rows.is_empty() {
                    continue;
                }
                let body = rows
                    .iter()
                    .map(|(id, kind, body)| format!("Message {id} ({kind}): {body}"))
                    .collect::<Vec<_>>()
                    .join("\n\n");
                let prompt=format!("Continue the existing feature/task. Process these concrete messages; acknowledge each through acknowledge_feature_message. Do not create duplicate work.\n\n{body}");
                session
                    .cmd_tx
                    .try_send(crate::sessions::SessionCommand::Prompt(prompt))
                    .map_err(|e| e.to_string())?;
                // Submitted means handed to ACP, not exactly-once execution. Only the recipient's ack confirms processing.
                for (id, _, _) in rows {
                    conn.execute("UPDATE orchestration_messages SET state='Submitted' WHERE id=?1 AND state='Pending'",[id]).map_err(|e|e.to_string())?;
                }
                session
                    .turn_active
                    .store(true, std::sync::atomic::Ordering::SeqCst);
                crate::task_store::transition::apply(
                    &conn,
                    &project,
                    task,
                    maestro_protocol::TaskTransition::Unblocked,
                    &maestro_protocol::TransitionGuard::Blocked,
                )?;
            }
        }
    }
    Ok(close)
}

pub fn record_turn(
    conn: &Connection,
    project: &str,
    task: i32,
    message: &str,
    failed: bool,
) -> Result<bool, String> {
    if let Some(mut f) = orchestrator_for(conn, project, task)? {
        crate::task_store::record_unfinished(conn, project, task, Some("Drafting"), message)?;
        if failed || (f.status == "Planning" && f.plan.is_empty()) {
            f.status = "Blocked".into();
            save_feature(conn, project, &f)?;
            crate::task_store::transition::apply(
                conn,
                project,
                task,
                maestro_protocol::TaskTransition::PhaseFailed,
                &maestro_protocol::TransitionGuard::Active,
            )?;
        } else {
            crate::task_store::transition::apply(
                conn,
                project,
                task,
                maestro_protocol::TaskTransition::AwaitingUserInput,
                &maestro_protocol::TransitionGuard::Active,
            )?;
        }
        return Ok(true);
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Connection, String) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().to_string_lossy().replace('\\', "/");
        std::fs::create_dir(directory.path().join(".maestro")).unwrap();
        std::fs::write(
            directory.path().join(".maestro/profiles.json"),
            json!({"profiles":[
                {"id":"planner","name":"Planner","role":"Planner","agent_id":"agent-a"},
                {"id":"coder","name":"Coder","role":"Coder","agent_id":"agent-b"}
            ]})
            .to_string(),
        )
        .unwrap();
        let mut conn = crate::project_store::open(directory.path()).unwrap();
        for (id, profile_id, orchestrator, worker) in [
            ("lead", "planner", true, false),
            ("worker", "coder", false, true),
        ] {
            answer(
                &mut conn,
                &path,
                Operation::SaveMember {
                    member: TeamMember {
                        id: id.into(),
                        profile_id: profile_id.into(),
                        name: id.into(),
                        strengths: String::new(),
                        enabled: true,
                        orchestrator,
                        worker,
                        reviewer: false,
                        max_sessions: 2,
                        priority: 0,
                    },
                },
                None,
            )
            .unwrap();
        }
        answer(
            &mut conn,
            &path,
            Operation::CreateFeature {
                title: "Test feature".into(),
                goal: "Implement the feature".into(),
                acceptance: vec!["Tests pass".into()],
                orchestrator_member: "lead".into(),
                allowed_members: vec!["worker".into()],
                max_parallel: 2,
                base_branch: "main".into(),
            },
            None,
        )
        .unwrap();
        (directory, conn, path)
    }

    fn plan() -> Vec<PlannedTask> {
        (0..3)
            .map(|n| PlannedTask {
                key: format!("t{n}"),
                title: format!("Task {n}"),
                instructions: "Implement and test".into(),
                acceptance: vec!["Pass".into()],
                member_id: "worker".into(),
                depends_on: if n == 2 { vec!["t0".into()] } else { vec![] },
            })
            .collect()
    }

    #[test]
    fn reviewers_and_orchestrators_share_their_profile_capacity_during_spawn() {
        let (_dir, mut conn, path) = fixture();
        let mut f = features(&conn, &path).unwrap().remove(0);
        let mut lead = member(&conn, &path, "lead").unwrap();
        lead.max_sessions = 1;
        answer(
            &mut conn,
            &path,
            Operation::SaveMember { member: lead },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::SaveMember {
                member: TeamMember {
                    id: "reviewer".into(),
                    profile_id: "planner".into(),
                    name: "Reviewer".into(),
                    strengths: String::new(),
                    enabled: true,
                    orchestrator: false,
                    worker: false,
                    reviewer: true,
                    max_sessions: 1,
                    priority: 0,
                },
            },
            None,
        )
        .unwrap();
        f.allowed_members.push("reviewer".into());
        save_feature(&conn, &path, &f).unwrap();
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let f = feature(&conn, &path, &f.id).unwrap();
        conn.execute("UPDATE tasks SET phase='Spawning', claimed_from='SelfReview', phase_status='Running' WHERE project_path=?1 AND id=?2", params![path, f.task_ids[0]]).unwrap();
        conn.execute("UPDATE tasks SET phase='SelfReview', phase_status='Waiting' WHERE project_path=?1 AND id=?2", params![path, f.task_ids[1]]).unwrap();
        assert!(check_start(&conn, &path, f.task_ids[1])
            .unwrap_err()
            .contains("session limit"));
        assert!(check_start(&conn, &path, f.orchestrator_task)
            .unwrap_err()
            .contains("session limit"));
        // The reviewer does not consume the coder's member capacity.
        assert!(check_start(&conn, &path, f.task_ids[2]).is_ok());
        // SessionReady checks exclude the claim they are validating.
        assert!(check_start(&conn, &path, f.task_ids[0]).is_ok());
        conn.execute(
            "UPDATE tasks SET phase_status='Waiting' WHERE project_path=?1 AND id=?2",
            params![path, f.task_ids[0]],
        )
        .unwrap();
        assert!(check_start(&conn, &path, f.task_ids[1]).is_ok());
        assert!(check_start(&conn, &path, f.orchestrator_task).is_ok());
    }

    #[test]
    fn workers_receive_feature_identity_and_same_session_question_instructions() {
        let (_dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let f = feature(&conn, &path, &f.id).unwrap();
        let context = worker_context(&conn, &path, f.task_ids[0])
            .unwrap()
            .unwrap();
        assert!(context.contains(&f.id));
        assert!(context.contains("send_feature_message"));
        assert!(context.contains("acknowledge_feature_message"));
        assert!(context.contains("same session"));
        assert!(worker_context(&conn, &path, f.orchestrator_task)
            .unwrap()
            .is_none());
        assert!(worker_context(&conn, "/other", f.task_ids[0])
            .unwrap()
            .is_none());
    }

    #[test]
    fn an_unreadable_review_cannot_pass_a_feature_task_or_spend_a_rework_round() {
        let (_dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let f = feature(&conn, &path, &f.id).unwrap();
        let task_id = f.task_ids[0];
        conn.execute("UPDATE tasks SET phase='SelfReview', phase_status='Running' WHERE project_path=?1 AND id=?2", params![path, task_id]).unwrap();
        let task = crate::task_store::end_turn(
            &mut conn,
            &maestro_protocol::EndTaskTurnRequest {
                project_path: path.clone(),
                task_id,
                ending: maestro_protocol::TurnEnding::ArtifactDelivered,
                review_approved: true,
                closing_message: "The provider returned an incomplete reply".into(),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(
            task.phase_status,
            Some(maestro_protocol::PhaseStatus::Failed)
        );
        assert_eq!(task.review_rounds, 0);
        assert!(check_start(&conn, &path, f.task_ids[2]).is_ok());
        assert_eq!(
            crate::task_store::dependencies::blockers(&conn, &path, f.task_ids[2]).unwrap(),
            vec![task_id]
        );
    }

    #[tokio::test]
    async fn a_stale_worktree_cannot_run_until_the_integrated_dependency_is_present() {
        let (dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let f = feature(&conn, &path, &f.id).unwrap();
        let git = |cwd: &std::path::Path, args: &[&str]| {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            String::from_utf8_lossy(&output.stdout).trim().to_string()
        };
        git(dir.path(), &["init", "-b", "main"]);
        git(dir.path(), &["config", "user.name", "Test"]);
        git(dir.path(), &["config", "user.email", "test@example.test"]);
        git(dir.path(), &["config", "commit.gpgsign", "false"]);
        git(dir.path(), &["commit", "--allow-empty", "-m", "Initial"]);
        let old = dir.path().join("old-worker");
        git(
            dir.path(),
            &["worktree", "add", "-b", "stale", old.to_str().unwrap()],
        );
        git(dir.path(), &["checkout", "-b", &f.integration_branch]);
        std::fs::write(dir.path().join("proof.txt"), "Integrated dependency").unwrap();
        git(dir.path(), &["add", "proof.txt"]);
        git(dir.path(), &["commit", "-m", "Dependency"]);
        let commit = git(dir.path(), &["rev-parse", "HEAD"]);
        answer(
            &mut conn,
            &path,
            Operation::RecordIntegration {
                task_id: f.task_ids[0],
                commit_sha: commit,
            },
            None,
        )
        .unwrap();
        let store = std::sync::Arc::new(tokio::sync::Mutex::new(conn));
        std::fs::write(old.join("personal.txt"), "Keep this").unwrap();
        assert!(
            verify_workspace_basis(&store, &path, f.task_ids[2], old.to_str().unwrap())
                .await
                .unwrap_err()
                .contains("missing from this worktree")
        );
        assert_eq!(
            std::fs::read_to_string(old.join("personal.txt")).unwrap(),
            "Keep this"
        );
        git(&old, &["merge", "--ff-only", &f.integration_branch]);
        verify_workspace_basis(&store, &path, f.task_ids[2], old.to_str().unwrap())
            .await
            .unwrap();
        assert!(old.join("proof.txt").exists());
    }

    #[test]
    fn cancelling_a_feature_while_a_worker_spawns_prevents_session_ready() {
        let (_dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let f = feature(&conn, &path, &f.id).unwrap();
        let task = f.task_ids[0];
        assert!(crate::task_store::transition::apply(
            &conn,
            &path,
            task,
            maestro_protocol::TaskTransition::ExecutionStarted,
            &maestro_protocol::TransitionGuard::Claim(vec![TaskStatus::Queue])
        )
        .unwrap()
        .is_some());
        answer(
            &mut conn,
            &path,
            Operation::Control {
                feature_id: f.id.clone(),
                command: "cancel".into(),
            },
            None,
        )
        .unwrap();
        assert!(crate::task_store::transition::apply(
            &conn,
            &path,
            task,
            maestro_protocol::TaskTransition::SessionReady(maestro_protocol::AgentRole::Coder),
            &maestro_protocol::TransitionGuard::Spawning
        )
        .is_err());
        assert_eq!(feature(&conn, &path, &f.id).unwrap().status, "Cancelled");
    }

    #[test]
    fn competing_database_connections_cannot_claim_one_worker_twice() {
        let (dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let task = feature(&conn, &path, &f.id).unwrap().task_ids[0];
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let threads = (0..2)
            .map(|_| {
                let db = dir.path().to_path_buf();
                let path = path.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut conn = crate::project_store::open(&db).unwrap();
                    barrier.wait();
                    crate::task_store::transition::apply_transition(
                        &mut conn,
                        &maestro_protocol::ApplyTaskTransitionRequest {
                            project_path: path,
                            task_id: task,
                            event: maestro_protocol::TaskTransition::ExecutionStarted,
                            guard: maestro_protocol::TransitionGuard::Claim(vec![
                                TaskStatus::Queue,
                            ]),
                            update: None,
                            comment: None,
                        },
                    )
                    .is_ok_and(|r| r.is_some())
                })
            })
            .collect::<Vec<_>>();
        assert_eq!(
            threads
                .into_iter()
                .map(|t| usize::from(t.join().unwrap()))
                .sum::<usize>(),
            1
        );
    }

    #[test]
    fn approval_is_atomic_idempotent_and_dependencies_gate_all_starts() {
        let (_dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: plan(),
            },
            Some(f.orchestrator_task),
        )
        .unwrap();
        assert!(answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone()
            },
            Some(f.orchestrator_task)
        )
        .is_err());
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        let f = feature(&conn, &path, &f.id).unwrap();
        assert_eq!(f.task_ids.len(), 3);
        assert_eq!(crate::task_store::list(&conn, &path).unwrap().len(), 4);
        let ids = crate::task_store::queue_candidates(
            &conn,
            &maestro_protocol::ListQueueCandidatesRequest {
                project_path: path.clone(),
                include_undeferred: true,
            },
        )
        .unwrap();
        assert_eq!(ids.len(), 2);
        let start = crate::task_store::transition::apply(
            &conn,
            &path,
            f.task_ids[2],
            maestro_protocol::TaskTransition::ExecutionStarted,
            &maestro_protocol::TransitionGuard::Claim(vec![TaskStatus::Queue]),
        );
        assert!(start.is_err());
        conn.execute(
            "UPDATE tasks SET status='Done',completion='LocalOnly' WHERE project_path=?1 AND id=?2",
            params![path, f.task_ids[0]],
        )
        .unwrap();
        assert!(
            !crate::task_store::dependencies::blockers(&conn, &path, f.task_ids[2])
                .unwrap()
                .is_empty()
        );
        conn.execute(
            "UPDATE tasks SET completion='Merged' WHERE project_path=?1 AND id=?2",
            params![path, f.task_ids[0]],
        )
        .unwrap();
        assert!(
            !crate::task_store::dependencies::blockers(&conn, &path, f.task_ids[2])
                .unwrap()
                .is_empty()
        );
        let commit_sha = "a".repeat(40);
        assert!(answer(
            &mut conn,
            &path,
            Operation::RecordIntegration {
                task_id: f.task_ids[0],
                commit_sha: commit_sha.clone()
            },
            Some(f.orchestrator_task)
        )
        .is_err());
        answer(
            &mut conn,
            &path,
            Operation::RecordIntegration {
                task_id: f.task_ids[0],
                commit_sha,
            },
            None,
        )
        .unwrap();
        assert!(
            crate::task_store::dependencies::blockers(&conn, &path, f.task_ids[2])
                .unwrap()
                .is_empty()
        );
        answer(
            &mut conn,
            &path,
            Operation::Control {
                feature_id: f.id.clone(),
                command: "pause".into(),
            },
            None,
        )
        .unwrap();
        assert!(check_start(&conn, &path, f.task_ids[1]).is_err());
    }

    #[test]
    fn cyclic_plan_and_wrong_feature_sender_write_nothing() {
        let (_dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        let mut tasks = plan();
        tasks[0].depends_on = vec!["t2".into()];
        assert!(answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks
            },
            Some(f.orchestrator_task)
        )
        .is_err());
        assert_eq!(feature(&conn, &path, &f.id).unwrap().status, "Planning");
        assert!(answer(
            &mut conn,
            &path,
            Operation::Message {
                feature_id: f.id,
                recipient_task: None,
                kind: "blocked".into(),
                body: "Question".into(),
                dedupe_key: "k".into()
            },
            Some(999)
        )
        .is_err());
    }

    #[test]
    fn messages_and_features_survive_restart_without_duplicate_delivery_records() {
        let (dir, mut conn, path) = fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        for _ in 0..2 {
            answer(
                &mut conn,
                &path,
                Operation::Message {
                    feature_id: f.id.clone(),
                    recipient_task: None,
                    kind: "instruction".into(),
                    body: "Clarification".into(),
                    dedupe_key: "same-message".into(),
                },
                None,
            )
            .unwrap();
        }
        let before = snapshot(&conn, &path).unwrap();
        assert_eq!(before["messages"].as_array().unwrap().len(), 1);
        let message_id = before["messages"][0]["id"].as_str().unwrap().to_string();
        assert!(answer(
            &mut conn,
            &path,
            Operation::Acknowledge {
                message_id: message_id.clone()
            },
            Some(999)
        )
        .is_err());
        drop(conn);
        let mut conn = crate::project_store::open(dir.path()).unwrap();
        assert_eq!(snapshot(&conn, &path).unwrap(), before);
        assert!(snapshot(&conn, "other-project").unwrap()["features"]
            .as_array()
            .unwrap()
            .is_empty());
        answer(
            &mut conn,
            &path,
            Operation::Acknowledge { message_id },
            Some(f.orchestrator_task),
        )
        .unwrap();
        assert_eq!(
            snapshot(&conn, &path).unwrap()["messages"][0]["state"],
            "Acknowledged"
        );
    }
}
