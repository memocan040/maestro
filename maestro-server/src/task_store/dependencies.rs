use rusqlite::{params, Connection};

pub fn blockers(conn: &Connection, project: &str, task: i32) -> Result<Vec<i32>, String> {
    let mut statement = conn.prepare(
        "SELECT r.from_task_id FROM task_relationships r
         JOIN tasks t ON t.project_path = r.project_path AND t.id = r.from_task_id
         WHERE r.project_path = ?1 AND r.to_task_id = ?2
           AND r.relationship_type = 'blocks' AND (t.status != 'Done' OR t.completion IS NULL
             OR (EXISTS(SELECT 1 FROM feature_tasks f WHERE f.project_path=r.project_path AND f.task_id=r.to_task_id)
                 AND (t.completion NOT IN ('Merged','MergedViaPR') OR NOT EXISTS (SELECT 1 FROM feature_integrations i WHERE i.project_path=t.project_path AND i.task_id=t.id))))",
    ).map_err(|e| e.to_string())?;
    let rows = statement
        .query_map(params![project, task], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

pub fn validate(conn: &Connection, project: &str, from: i32, to: i32) -> Result<(), String> {
    if from == to {
        return Err("A task cannot depend on itself".into());
    }
    let cycle: bool = conn
        .query_row(
            "WITH RECURSIVE reachable(id) AS (
             SELECT ?2 UNION SELECT r.to_task_id FROM task_relationships r
             JOIN reachable p ON p.id = r.from_task_id
             WHERE r.project_path = ?1 AND r.relationship_type = 'blocks'
         ) SELECT EXISTS(SELECT 1 FROM reachable WHERE id = ?3)",
            params![project, to, from],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    if cycle {
        return Err("This dependency would create a cycle".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task_store::{add_relationship, tests::new_task};

    #[test]
    fn an_empty_planner_result_fails_and_can_be_retried() {
        use maestro_protocol::{
            AgentRole, PhaseStatus, TaskTransition, TransitionGuard, TurnEnding,
        };
        let mut conn = crate::project_store::open_in_memory();
        let task = new_task(&mut conn, "/p", "Plan task");
        crate::task_store::transition::apply(
            &conn,
            "/p",
            task.id,
            TaskTransition::SessionReady(AgentRole::Planner),
            &TransitionGuard::Always,
        )
        .unwrap();
        let result = crate::task_store::end_turn(
            &mut conn,
            &maestro_protocol::EndTaskTurnRequest {
                project_path: "/p".into(),
                task_id: task.id,
                ending: TurnEnding::Completed {
                    is_git_repo: true,
                    has_changes: None,
                    reviewer_pending: false,
                },
                closing_message: crate::turn::COMPLETION_MARKER.into(),
                review_approved: false,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(result.phase_status, Some(PhaseStatus::Failed));
        assert!(
            crate::task_store::latest_of_kind(&conn, "/p", task.id, "plan")
                .unwrap()
                .is_none()
        );
        assert!(crate::task_store::transition::apply(
            &conn,
            "/p",
            task.id,
            TaskTransition::ExecutionStarted,
            &TransitionGuard::Claim(vec![maestro_protocol::TaskStatus::Planning])
        )
        .unwrap()
        .is_some());
    }

    #[test]
    fn dependencies_are_directed_scoped_and_acyclic() {
        let mut conn = crate::project_store::open_in_memory();
        let a = new_task(&mut conn, "/p", "task a").id;
        let b = new_task(&mut conn, "/p", "task b").id;
        let c = new_task(&mut conn, "/p", "task c").id;
        add_relationship(&conn, "/p", a, b, "blocks").unwrap();
        add_relationship(&conn, "/p", b, c, "blocks").unwrap();
        assert!(add_relationship(&conn, "/p", c, a, "blocks").is_err());
        assert!(add_relationship(&conn, "/p", a, a, "blocks").is_err());
        assert_eq!(blockers(&conn, "/p", b).unwrap(), vec![a]);
        assert!(blockers(&conn, "/other", b).unwrap().is_empty());
        conn.execute(
            "UPDATE tasks SET status = 'Done' WHERE project_path = '/p' AND id = ?1",
            [a],
        )
        .unwrap();
        assert_eq!(blockers(&conn, "/p", b).unwrap(), vec![a]);
        conn.execute(
            "UPDATE tasks SET completion = 'Merged' WHERE project_path = '/p' AND id = ?1",
            [a],
        )
        .unwrap();
        assert!(blockers(&conn, "/p", b).unwrap().is_empty());
    }
}
