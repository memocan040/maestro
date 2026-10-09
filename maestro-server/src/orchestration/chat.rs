//! Bounded consultations share feature tasks, identities and the existing ACP pipeline.
use super::*;
use maestro_protocol::{FeatureDiscussion, TeamChatSettings};

pub const V12_TEAM_CHAT: &str = "
ALTER TABLE orchestration_messages ADD COLUMN sender_name TEXT;
ALTER TABLE orchestration_messages ADD COLUMN sender_agent TEXT;
ALTER TABLE orchestration_messages ADD COLUMN sender_role TEXT;
CREATE TABLE team_chat_settings (project_path TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE feature_discussions (
 project_path TEXT NOT NULL, id TEXT NOT NULL, feature_id TEXT NOT NULL, dedupe_key TEXT NOT NULL, body TEXT NOT NULL,
 PRIMARY KEY(project_path,id), UNIQUE(project_path,feature_id,dedupe_key),
 FOREIGN KEY(project_path,feature_id) REFERENCES features(project_path,id)
);
CREATE TABLE feature_consultations (
 project_path TEXT NOT NULL, task_id INTEGER NOT NULL, feature_id TEXT NOT NULL, discussion_id TEXT NOT NULL,
 member_id TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'Pending', result TEXT NOT NULL DEFAULT '', round INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(project_path,task_id),
 FOREIGN KEY(project_path,task_id) REFERENCES tasks(project_path,id),
 FOREIGN KEY(project_path,discussion_id) REFERENCES feature_discussions(project_path,id)
);
";

pub const V13_CHAT_STARTS: &str = "
CREATE TABLE feature_chat_starts (
 project_path TEXT NOT NULL, task_id INTEGER NOT NULL, state TEXT NOT NULL,
 PRIMARY KEY(project_path,task_id),
 FOREIGN KEY(project_path,task_id) REFERENCES tasks(project_path,id)
);
";

pub fn request_start(conn: &Connection, project: &str, task: i32) -> Result<(), String> {
    let has_session: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sessions WHERE project_path=?1 AND task_id=?2)",
            params![project, task],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if !has_session {
        conn.execute("INSERT INTO feature_chat_starts(project_path,task_id,state) VALUES(?1,?2,'Pending') ON CONFLICT DO NOTHING",params![project,task]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub fn active_turn(conn: &Connection, project: &str, task: i32) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM feature_chat_starts WHERE project_path=?1 AND task_id=?2 AND state='Active')",params![project,task],|r|r.get(0)).map_err(|e|e.to_string())
}

pub fn mark_turn(conn: &Connection, project: &str, task: i32) -> Result<(), String> {
    conn.execute("INSERT INTO feature_chat_starts(project_path,task_id,state) VALUES(?1,?2,'Active') ON CONFLICT(project_path,task_id) DO UPDATE SET state='Active'",params![project,task]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn claim_start(conn: &Connection, project: &str, task: i32) -> Result<(), String> {
    if is_consultation(conn, project, task)? {
        conn.execute("UPDATE feature_consultations SET state='Starting' WHERE project_path=?1 AND task_id=?2 AND state='Pending'",params![project,task]).map_err(|e|e.to_string())?;
    } else {
        mark_turn(conn, project, task)?;
        conn.execute("UPDATE orchestration_messages SET state='Submitted' WHERE id IN (SELECT id FROM orchestration_messages WHERE project_path=?1 AND recipient_task=?2 AND state='Pending' ORDER BY rowid LIMIT 8)",params![project,task]).map_err(|e|e.to_string())?;
    }
    Ok(())
}

pub fn failed_start(
    conn: &Connection,
    project: &str,
    task: i32,
    reason: &str,
) -> Result<(), String> {
    conn.execute("UPDATE feature_consultations SET state='Uncertain',result=?1 WHERE project_path=?2 AND task_id=?3",params![reason,project,task]).map_err(|e|e.to_string())?;
    conn.execute(
        "UPDATE feature_chat_starts SET state='Uncertain' WHERE project_path=?1 AND task_id=?2",
        params![project, task],
    )
    .map_err(|e| e.to_string())?;
    conn.execute("UPDATE orchestration_messages SET state='Submitted' WHERE project_path=?1 AND recipient_task=?2 AND state='Pending'",params![project,task]).map_err(|e|e.to_string())?;
    Ok(())
}

pub fn settings(conn: &Connection, project: &str) -> Result<TeamChatSettings, String> {
    let text: Option<String> = conn
        .query_row(
            "SELECT body FROM team_chat_settings WHERE project_path=?1",
            [project],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    text.map(decode).transpose().map(|s| s.unwrap_or_default())
}
pub fn discussions(conn: &Connection, project: &str) -> Result<Vec<FeatureDiscussion>, String> {
    bodies(conn, "feature_discussions", project)
}
fn save(conn: &Connection, project: &str, d: &FeatureDiscussion) -> Result<(), String> {
    conn.execute(
        "UPDATE feature_discussions SET body=?1 WHERE project_path=?2 AND id=?3",
        params![
            serde_json::to_string(d).map_err(|e| e.to_string())?,
            project,
            d.id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
fn get(conn: &Connection, project: &str, id: &str) -> Result<FeatureDiscussion, String> {
    discussions(conn, project)?
        .into_iter()
        .find(|d| d.id == id)
        .ok_or("Discussion not found".into())
}
pub fn belongs(conn: &Connection, project: &str, feature: &str, task: i32) -> Result<bool, String> {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM feature_consultations WHERE project_path=?1 AND feature_id=?2 AND task_id=?3)",params![project,feature,task],|r|r.get(0)).map_err(|e|e.to_string())
}
pub fn is_consultation(conn: &Connection, project: &str, task: i32) -> Result<bool, String> {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM feature_consultations WHERE project_path=?1 AND task_id=?2)",
        params![project, task],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
fn authorize(
    conn: &Connection,
    project: &str,
    feature_id: &str,
    actor: Option<i32>,
) -> Result<Feature, String> {
    let f = feature(conn, project, feature_id)?;
    if actor.is_some_and(|a| a != f.orchestrator_task) {
        return Err("Only the user or feature orchestrator coordinates discussions".into());
    }
    if matches!(f.status.as_str(), "Paused" | "Completed" | "Cancelled") {
        return Err(format!("Feature is {}", f.status));
    }
    Ok(f)
}
pub fn answer(
    conn: &Connection,
    project: &str,
    op: &Operation,
    actor: Option<i32>,
) -> Result<bool, String> {
    match op {
        Operation::ChatSettings {
            max_consultants,
            max_rounds,
        } => {
            if actor.is_some() {
                return Err("Only the user configures project discussion limits".into());
            }
            if !(1..=4).contains(max_consultants) || !(1..=4).contains(max_rounds) {
                return Err("Discussion limits must be between 1 and 4".into());
            }
            conn.execute("INSERT INTO team_chat_settings(project_path,body) VALUES(?1,?2) ON CONFLICT(project_path) DO UPDATE SET body=excluded.body",params![project,serde_json::to_string(&TeamChatSettings{max_consultants:*max_consultants,max_rounds:*max_rounds}).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
        }
        Operation::StartDiscussion {
            feature_id,
            goal,
            member_ids,
            dedupe_key,
        } => {
            let f = authorize(conn, project, feature_id, actor)?;
            if goal.trim().is_empty()
                || goal.len() > 4096
                || dedupe_key.is_empty()
                || dedupe_key.len() > 200
            {
                return Err(
                    "A discussion needs a bounded concrete goal and idempotency key".into(),
                );
            }
            let old = discussions(conn, project)?;
            if old
                .iter()
                .any(|d| d.feature_id == *feature_id && d.goal.trim() == goal.trim())
            {
                return Ok(true);
            }
            let duplicate:bool=conn.query_row("SELECT EXISTS(SELECT 1 FROM feature_discussions WHERE project_path=?1 AND feature_id=?2 AND dedupe_key=?3)",params![project,feature_id,dedupe_key],|r|r.get(0)).map_err(|e|e.to_string())?;
            if duplicate {
                return Ok(true);
            }
            if old
                .iter()
                .any(|d| d.feature_id == *feature_id && d.state != "Closed")
            {
                return Err("Finish the current discussion first; nested consultations cannot reset its budget".into());
            }
            let limits = settings(conn, project)?;
            let source_message: Option<String> = if actor.is_some() {
                conn.query_row("SELECT id FROM orchestration_messages WHERE project_path=?1 AND feature_id=?2 AND sender_task IS NULL AND kind!='note' ORDER BY rowid DESC LIMIT 1",params![project,feature_id],|r|r.get(0)).optional().map_err(|e|e.to_string())?.or(Some("feature-created".into()))
            } else {
                Some(format!("user-discussion:{dedupe_key}"))
            };
            if actor.is_some()
                && old
                    .iter()
                    .any(|d| d.feature_id == *feature_id && d.source_message == source_message)
            {
                return Err("Consultation budget for this user request is exhausted; ask the user before another discussion".into());
            }
            let unique = member_ids.iter().collect::<std::collections::HashSet<_>>();
            if member_ids.is_empty()
                || unique.len() != member_ids.len()
                || member_ids.len() > limits.max_consultants
            {
                return Err(
                    "Discussion participant limit exceeded or duplicate participant".into(),
                );
            }
            let mut d = FeatureDiscussion {
                id: uuid::Uuid::new_v4().to_string(),
                feature_id: feature_id.clone(),
                goal: goal.clone(),
                member_ids: member_ids.clone(),
                task_ids: vec![],
                round: 1,
                max_rounds: limits.max_rounds,
                state: "Running".into(),
                summary: String::new(),
                created_at: Utc::now().to_rfc3339(),
                source_message,
            };
            conn.execute("INSERT INTO feature_discussions(project_path,id,feature_id,dedupe_key,body) VALUES(?1,?2,?3,?4,?5)",params![project,d.id,feature_id,dedupe_key,serde_json::to_string(&d).map_err(|e|e.to_string())?]).map_err(|e|e.to_string())?;
            for id in member_ids {
                let m = member(conn, project, id)?;
                if id == &f.orchestrator_member || !f.allowed_members.contains(id) {
                    return Err("Consultant must be an allowed feature team member other than its orchestrator".into());
                }
                let p = profile(project, &m)?;
                let instructions=format!("Bounded read-only consultation, round 1 of {}. Feature: {}. Goal: {}. Answer only this concrete question with a concise recommendation and evidence. Do not implement code, delegate, start other discussions, approve work, or integrate Git. Return your answer in your final message. The orchestrator receives it once. No full chat replay.",d.max_rounds,f.goal,goal);
                let task = create_task(
                    conn,
                    project,
                    &format!(
                        "Consult {}: {}",
                        m.name,
                        goal.chars().take(80).collect::<String>()
                    ),
                    &instructions,
                    &f.base_branch,
                    &p.agent_id,
                )?;
                let overrides =
                    json!({"Planner":p.id,"Coder":null,"Reviewer":null,"Refiner":null}).to_string();
                conn.execute(
                    "UPDATE tasks SET profile_overrides=?1 WHERE project_path=?2 AND id=?3",
                    params![overrides, project, task],
                )
                .map_err(|e| e.to_string())?;
                conn.execute("INSERT INTO feature_consultations(project_path,task_id,feature_id,discussion_id,member_id) VALUES(?1,?2,?3,?4,?5)",params![project,task,feature_id,d.id,id]).map_err(|e|e.to_string())?;
                d.task_ids.push(task);
            }
            save(conn, project, &d)?;
        }
        Operation::AdvanceDiscussion {
            discussion_id,
            question,
        } => {
            let mut d = get(conn, project, discussion_id)?;
            authorize(conn, project, &d.feature_id, actor)?;
            if d.state != "AwaitingDecision" {
                return Err(
                    "Wait for this discussion's current answers before another round".into(),
                );
            }
            if d.round >= d.max_rounds {
                return Err(
                    "Discussion round limit reached; close it or ask the user to decide".into(),
                );
            }
            if question.trim().is_empty() || question.len() > 4096 {
                return Err("A follow-up needs a concrete bounded question".into());
            }
            d.round += 1;
            d.state = "Running".into();
            for task in &d.task_ids {
                let body=format!("Discussion {}. Round {}/{}. Goal: {}. Follow-up: {}. Reply concisely, do not delegate or implement. End when answered.",d.id,d.round,d.max_rounds,d.goal,question);
                conn.execute("INSERT INTO orchestration_messages(id,project_path,feature_id,dedupe_key,sender_task,recipient_task,kind,body,created_at,sender_role) VALUES(?1,?2,?3,?4,?5,?6,'instruction',?7,?8,'Orchestrator')",params![uuid::Uuid::new_v4().to_string(),project,d.feature_id,format!("discussion:{}:{}:{}",d.id,d.round,task),actor,task,body,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
            }
            save(conn, project, &d)?;
        }
        Operation::CloseDiscussion {
            discussion_id,
            summary,
        } => {
            let mut d = get(conn, project, discussion_id)?;
            authorize(conn, project, &d.feature_id, actor)?;
            if summary.trim().is_empty() || summary.len() > 4096 {
                return Err("A discussion needs a concise closing decision or escalation".into());
            }
            if d.state == "Closed" {
                return Ok(true);
            }
            d.state = "Closed".into();
            d.summary = summary.clone();
            save(conn, project, &d)?;
            conn.execute("UPDATE feature_consultations SET state='Closed' WHERE project_path=?1 AND discussion_id=?2",params![project,d.id]).map_err(|e|e.to_string())?;
            conn.execute("INSERT INTO orchestration_messages(id,project_path,feature_id,dedupe_key,sender_task,recipient_task,kind,body,state,created_at,sender_role) VALUES(?1,?2,?3,?4,?5,?6,'decision',?7,'Recorded',?8,'Decision') ON CONFLICT(project_path,feature_id,dedupe_key) DO NOTHING",params![uuid::Uuid::new_v4().to_string(),project,d.feature_id,format!("discussion-close:{}",d.id),actor,feature(conn,project,&d.feature_id)?.orchestrator_task,summary,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
        }
        _ => return Ok(false),
    }
    Ok(true)
}

pub fn record_result(
    conn: &Connection,
    project: &str,
    task: i32,
    message: &str,
    failed: bool,
) -> Result<bool, String> {
    let row:Option<(String,String,i64)>=conn.query_row("SELECT discussion_id,state,round FROM feature_consultations WHERE project_path=?1 AND task_id=?2",params![project,task],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|e|e.to_string())?;
    let Some((id, state, last_round)) = row else {
        return Ok(false);
    };
    let mut d = get(conn, project, &id)?;
    if d.state == "Closed" || (state == "Answered" && last_round == d.round as i64) {
        return Ok(true);
    }
    let result = message.chars().take(4096).collect::<String>();
    conn.execute("UPDATE feature_consultations SET state=?1,result=?2,round=?3 WHERE project_path=?4 AND task_id=?5",params![if failed {"Uncertain"} else {"Answered"},result,d.round as i64,project,task]).map_err(|e|e.to_string())?;
    let f = feature(conn, project, &d.feature_id)?;
    conn.execute("INSERT INTO orchestration_messages(id,project_path,feature_id,dedupe_key,sender_task,recipient_task,kind,body,created_at,sender_role) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,'Consultant') ON CONFLICT(project_path,feature_id,dedupe_key) DO NOTHING",params![uuid::Uuid::new_v4().to_string(),project,d.feature_id,format!("consultation:{}:{}",task,d.round),task,f.orchestrator_task,if failed {"blocked"} else {"answer"},result,Utc::now().to_rfc3339()]).map_err(|e|e.to_string())?;
    let missing:i64=conn.query_row("SELECT COUNT(*) FROM feature_consultations WHERE project_path=?1 AND discussion_id=?2 AND (state!='Answered' OR round!=?3)",params![project,id,d.round as i64],|r|r.get(0)).map_err(|e|e.to_string())?;
    if failed {
        d.state = "AwaitingUser".into();
    } else if missing == 0 {
        d.state = "AwaitingDecision".into();
    }
    save(conn, project, &d)?;
    crate::task_store::record_unfinished(conn, project, task, Some("Drafting"), &result)?;
    crate::task_store::transition::apply(
        conn,
        project,
        task,
        maestro_protocol::TaskTransition::AwaitingUserInput,
        &maestro_protocol::TransitionGuard::Active,
    )?;
    super::notify();
    Ok(true)
}

pub fn pending(conn: &Connection) -> Result<Vec<(String, i32)>, String> {
    let mut stmt=conn.prepare("SELECT c.project_path,c.task_id FROM feature_consultations c JOIN features f ON f.project_path=c.project_path AND f.id=c.feature_id WHERE c.state='Pending' AND json_extract(f.body,'$.status') NOT IN ('Paused','Cancelled','Completed') UNION ALL SELECT c.project_path,c.task_id FROM feature_chat_starts c JOIN features f ON f.project_path=c.project_path AND json_extract(f.body,'$.orchestrator_task')=c.task_id JOIN tasks t ON t.project_path=c.project_path AND t.id=c.task_id WHERE c.state='Pending' AND NOT EXISTS(SELECT 1 FROM sessions s WHERE s.project_path=c.project_path AND s.task_id=c.task_id) AND json_extract(f.body,'$.status') NOT IN ('Paused','Cancelled','Completed')").map_err(|e|e.to_string())?;
    let result = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string());
    result
}

pub fn reconcile(conn: &Connection) -> Result<(), String> {
    conn.execute("UPDATE feature_chat_starts SET state='Uncertain' WHERE state='Active' AND EXISTS(SELECT 1 FROM tasks t WHERE t.project_path=feature_chat_starts.project_path AND t.id=feature_chat_starts.task_id AND t.phase_status='Failed')",[]).map_err(|e|e.to_string())?;
    let mut stmt=conn.prepare("SELECT c.project_path,c.task_id,c.discussion_id,t.phase_status FROM feature_consultations c JOIN tasks t ON t.project_path=c.project_path AND t.id=c.task_id WHERE (c.state='Starting' AND t.phase_status='Failed') OR c.state='Uncertain'").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i32>(1)?,
                r.get::<_, String>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    for (project, task, id) in rows {
        conn.execute("UPDATE feature_consultations SET state='Uncertain' WHERE project_path=?1 AND task_id=?2",params![project,task]).map_err(|e|e.to_string())?;
        let mut d = get(conn, &project, &id)?;
        if d.state != "Closed" {
            d.state = "AwaitingUser".into();
            save(conn, &project, &d)?;
        }
    }
    Ok(())
}

pub fn decisions(conn: &Connection, project: &str, feature_id: &str) -> Result<String, String> {
    let mut stmt=conn.prepare("SELECT body FROM orchestration_messages WHERE project_path=?1 AND feature_id=?2 AND kind='decision' ORDER BY rowid DESC LIMIT 5").map_err(|e|e.to_string())?;
    let rows = stmt
        .query_map(params![project, feature_id], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .rev()
        .map(|s| s.chars().take(1024).collect::<String>())
        .collect::<Vec<_>>()
        .join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_chat_is_explicit_and_does_not_relax_the_planner_artifact_gate() {
        let (_dir, mut conn, path) = super::super::tests::fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "note", "Stored note", "note", None),
            None,
        )
        .unwrap();
        assert!(pending(&conn).unwrap().is_empty());
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "question", "Stored status?", "question", None),
            None,
        )
        .unwrap();
        assert_eq!(
            pending(&conn).unwrap(),
            vec![(path.clone(), f.orchestrator_task)]
        );
        claim_start(&conn, &path, f.orchestrator_task).unwrap();
        let prompt = super::super::prompt(&conn, &path, f.orchestrator_task)
            .unwrap()
            .unwrap();
        assert!(prompt.contains("Stored status?"));
        assert!(prompt.contains("bounded conversation"));
        conn.execute("UPDATE tasks SET phase='Drafting',phase_status='Running' WHERE project_path=?1 AND id=?2",params![path,f.orchestrator_task]).unwrap();
        super::super::record_turn(&conn, &path, f.orchestrator_task, "Still planning", false)
            .unwrap();
        assert_eq!(feature(&conn, &path, &f.id).unwrap().status, "Planning");
        assert!(!active_turn(&conn, &path, f.orchestrator_task).unwrap());
        conn.execute("UPDATE tasks SET phase='Drafting',phase_status='Running' WHERE project_path=?1 AND id=?2",params![path,f.orchestrator_task]).unwrap();
        super::super::record_turn(
            &conn,
            &path,
            f.orchestrator_task,
            "Planner delivered no plan",
            false,
        )
        .unwrap();
        assert_eq!(feature(&conn, &path, &f.id).unwrap().status, "Blocked");
    }
    #[test]
    fn failed_initial_chat_requires_explicit_retry_instead_of_another_paid_start() {
        let (_dir, mut conn, path) = super::super::tests::fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "question", "Question", "failure", None),
            None,
        )
        .unwrap();
        claim_start(&conn, &path, f.orchestrator_task).unwrap();
        conn.execute("UPDATE tasks SET phase='Drafting',phase_status='Failed' WHERE project_path=?1 AND id=?2",params![path,f.orchestrator_task]).unwrap();
        reconcile(&conn).unwrap();
        assert!(pending(&conn).unwrap().is_empty());
        let snap = super::super::snapshot(&conn, &path).unwrap();
        assert_eq!(snap["messages"][0]["state"], "Submitted");
        super::super::answer(
            &mut conn,
            &path,
            Operation::RetryMessage {
                message_id: snap["messages"][0]["id"].as_str().unwrap().into(),
            },
            None,
        )
        .unwrap();
        assert_eq!(pending(&conn).unwrap(), vec![(path, f.orchestrator_task)]);
    }
    #[tokio::test]
    async fn busy_and_offline_sessions_buffer_messages_and_uncertain_work_is_not_replayed() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let (_dir, mut conn, path) = super::super::tests::fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "question", "Concrete question", "busy", None),
            None,
        )
        .unwrap();
        conn.execute("UPDATE tasks SET phase='Drafting',phase_status='Blocked' WHERE project_path=?1 AND id=?2",params![path,f.orchestrator_task]).unwrap();
        let store = Arc::new(tokio::sync::Mutex::new(conn));
        let (tx, mut rx) = tokio::sync::mpsc::channel(4);
        let busy = Arc::new(AtomicBool::new(true));
        let session = crate::sessions::ActiveSession {
            cmd_tx: tx,
            pending_permissions: Default::default(),
            pending_elicitations: Default::default(),
            task: tokio::spawn(std::future::pending()),
            cleanup: None,
            agent_id: "agent-a".into(),
            cwd: path.clone(),
            additional_directories: vec![],
            project: Some(crate::sessions::ProjectBinding {
                project_path: path.clone(),
                meta: maestro_protocol::SessionMeta {
                    task_id: Some(f.orchestrator_task),
                    role: Some("Planner".into()),
                    ..Default::default()
                },
                can_reload: true,
                requested_at: Utc::now(),
            }),
            turn_active: busy.clone(),
            idle_marked: false,
        };
        let mut sessions = crate::sessions::SessionMap::new();
        sessions.insert("same-session".into(), session);
        super::super::pump(&store, &sessions).await.unwrap();
        assert!(rx.try_recv().is_err());
        assert_eq!(
            snapshot(&*store.lock().await, &path).unwrap()["messages"][0]["state"],
            "Pending"
        );
        super::super::pump(&store, &crate::sessions::SessionMap::new())
            .await
            .unwrap();
        busy.store(false, Ordering::SeqCst);
        super::super::pump(&store, &sessions).await.unwrap();
        let crate::sessions::SessionCommand::Prompt(prompt) = rx.try_recv().unwrap() else {
            panic!("Expected one concrete prompt")
        };
        assert!(prompt.contains("Concrete question"));
        let snap = snapshot(&*store.lock().await, &path).unwrap();
        let id = snap["messages"][0]["id"].as_str().unwrap().to_string();
        assert_eq!(snap["messages"][0]["state"], "Submitted");
        busy.store(false, Ordering::SeqCst);
        super::super::pump(&store, &sessions).await.unwrap();
        assert!(rx.try_recv().is_err());
        for _ in 0..2 {
            super::super::answer(
                &mut *store.lock().await,
                &path,
                Operation::Acknowledge {
                    message_id: id.clone(),
                },
                Some(f.orchestrator_task),
            )
            .unwrap();
        }
        assert_eq!(
            snapshot(&*store.lock().await, &path).unwrap()["messages"][0]["state"],
            "Acknowledged"
        );
        sessions["same-session"].task.abort();
    }
    fn message(f: &Feature, kind: &str, body: &str, key: &str, to: Option<i32>) -> Operation {
        Operation::Message {
            feature_id: f.id.clone(),
            recipient_task: to,
            kind: kind.into(),
            body: body.into(),
            dedupe_key: key.into(),
        }
    }
    fn started(conn: &Connection, path: &str, task: i32) {
        conn.execute("UPDATE tasks SET phase='Drafting',phase_status='Running' WHERE project_path=?1 AND id=?2",params![path,task]).unwrap();
    }
    #[test]
    fn activity_is_recorded_without_pending_provider_work() {
        let (_dir, mut conn, path) = super::super::tests::fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "note", "Saved note", "note", None),
            None,
        )
        .unwrap();
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "progress", "Actual progress", "p", None),
            Some(f.orchestrator_task),
        )
        .unwrap();
        let snapshot = snapshot(&conn, &path).unwrap();
        assert!(snapshot["messages"]
            .as_array()
            .unwrap()
            .iter()
            .all(|m| m["state"] == "Recorded"));
        assert!(pending(&conn).unwrap().is_empty());
    }
    #[test]
    fn user_orchestrator_worker_response_and_decision_survive_reopen() {
        let (dir, mut conn, path) = super::super::tests::fixture();
        let mut f = features(&conn, &path).unwrap().remove(0);
        super::super::answer(
            &mut conn,
            &path,
            Operation::SubmitPlan {
                feature_id: f.id.clone(),
                tasks: super::super::tests::plan(),
            },
            None,
        )
        .unwrap();
        super::super::answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone(),
            },
            None,
        )
        .unwrap();
        f = feature(&conn, &path, &f.id).unwrap();
        let worker = f.task_ids[0];
        for (op, actor) in [
            (message(&f, "question", "Which API?", "u", None), None),
            (
                message(&f, "instruction", "Use API v2", "o", Some(worker)),
                Some(f.orchestrator_task),
            ),
            (
                message(&f, "question", "Support negatives?", "w", None),
                Some(worker),
            ),
            (
                message(&f, "answer", "Yes, negatives", "a", Some(worker)),
                None,
            ),
            (
                message(&f, "decision", "API v2 is the durable decision", "d", None),
                None,
            ),
        ] {
            super::super::answer(&mut conn, &path, op, actor).unwrap();
        }
        // Repeated identical questions with a new key do not schedule duplicate work.
        super::super::answer(
            &mut conn,
            &path,
            message(&f, "question", "Support negatives?", "w2", None),
            Some(worker),
        )
        .unwrap();
        assert_eq!(
            snapshot(&conn, &path).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::ApprovePlan {
                feature_id: f.id.clone()
            },
            Some(worker)
        )
        .is_err());
        assert!(super::super::worker_context(&conn, &path, worker)
            .unwrap()
            .unwrap()
            .contains("API v2 is the durable decision"));
        drop(conn);
        let conn = crate::project_store::open(dir.path()).unwrap();
        assert_eq!(
            snapshot(&conn, &path).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(feature(&conn, &path, &f.id).unwrap().task_ids.len(), 3);
    }
    #[test]
    fn discussion_rounds_are_bounded_idempotent_and_do_not_create_workers() {
        let (_dir, mut conn, path) = super::super::tests::fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        let op = || Operation::StartDiscussion {
            feature_id: f.id.clone(),
            goal: "Choose API boundary".into(),
            member_ids: vec!["worker".into()],
            dedupe_key: "meeting".into(),
        };
        super::super::answer(&mut conn, &path, op(), None).unwrap();
        super::super::answer(&mut conn, &path, op(), None).unwrap();
        let d = discussions(&conn, &path).unwrap().remove(0);
        assert_eq!(d.task_ids.len(), 1);
        assert!(feature(&conn, &path, &f.id).unwrap().task_ids.is_empty());
        assert_eq!(feature(&conn, &path, &f.id).unwrap().status, "Planning");
        let task = d.task_ids[0];
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::StartDiscussion {
                feature_id: f.id.clone(),
                goal: "Nested goal".into(),
                member_ids: vec!["worker".into()],
                dedupe_key: "nested".into()
            },
            Some(task)
        )
        .is_err());
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::AdvanceDiscussion {
                discussion_id: d.id.clone(),
                question: "Too early".into()
            },
            None
        )
        .is_err());
        started(&conn, &path, task);
        record_result(&conn, &path, task, "Use API v2", false).unwrap();
        record_result(&conn, &path, task, "Use API v2", false).unwrap();
        assert_eq!(
            snapshot(&conn, &path).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        super::super::answer(
            &mut conn,
            &path,
            Operation::AdvanceDiscussion {
                discussion_id: d.id.clone(),
                question: "How to version?".into(),
            },
            Some(f.orchestrator_task),
        )
        .unwrap();
        started(&conn, &path, task);
        record_result(&conn, &path, task, "Version the URL", false).unwrap();
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::AdvanceDiscussion {
                discussion_id: d.id.clone(),
                question: "Third round".into()
            },
            None
        )
        .is_err());
        super::super::answer(
            &mut conn,
            &path,
            Operation::CloseDiscussion {
                discussion_id: d.id.clone(),
                summary: "API v2, versioned URL".into(),
            },
            Some(f.orchestrator_task),
        )
        .unwrap();
        assert_eq!(discussions(&conn, &path).unwrap()[0].state, "Closed");
        assert!(decisions(&conn, &path, &f.id)
            .unwrap()
            .contains("versioned URL"));
    }
    #[test]
    fn project_limits_and_human_request_budget_prevent_nested_reset() {
        let (_dir, mut conn, path) = super::super::tests::fixture();
        let f = features(&conn, &path).unwrap().remove(0);
        assert_eq!(settings(&conn, &path).unwrap().max_consultants, 2);
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::ChatSettings {
                max_consultants: 4,
                max_rounds: 4
            },
            Some(f.orchestrator_task)
        )
        .is_err());
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::StartDiscussion {
                feature_id: f.id.clone(),
                goal: "Too many".into(),
                member_ids: vec!["a".into(), "b".into(), "c".into()],
                dedupe_key: "too-many".into()
            },
            None
        )
        .is_err());
        super::super::answer(
            &mut conn,
            &path,
            Operation::StartDiscussion {
                feature_id: f.id.clone(),
                goal: "First goal".into(),
                member_ids: vec!["worker".into()],
                dedupe_key: "first".into(),
            },
            Some(f.orchestrator_task),
        )
        .unwrap();
        let d = discussions(&conn, &path).unwrap().remove(0);
        super::super::answer(
            &mut conn,
            &path,
            Operation::CloseDiscussion {
                discussion_id: d.id,
                summary: "Escalate to user".into(),
            },
            Some(f.orchestrator_task),
        )
        .unwrap();
        assert!(super::super::answer(
            &mut conn,
            &path,
            Operation::StartDiscussion {
                feature_id: f.id.clone(),
                goal: "Second goal".into(),
                member_ids: vec!["worker".into()],
                dedupe_key: "reset".into()
            },
            Some(f.orchestrator_task)
        )
        .is_err());
        super::super::answer(
            &mut conn,
            &path,
            message(
                &f,
                "question",
                "New explicit user question",
                "new-user",
                None,
            ),
            None,
        )
        .unwrap();
        super::super::answer(
            &mut conn,
            &path,
            Operation::StartDiscussion {
                feature_id: f.id,
                goal: "Second goal".into(),
                member_ids: vec!["worker".into()],
                dedupe_key: "authorized-new".into(),
            },
            Some(f.orchestrator_task),
        )
        .unwrap();
    }
}
