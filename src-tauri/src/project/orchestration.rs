use crate::acp::connection_server::{query_project_store, reply};
use crate::core::AppState;
use maestro_protocol::{OrchestrationRequest, ServerRequest, ServerResponse};
use std::sync::Arc;
use tauri::State;

#[derive(Clone, serde::Serialize, specta::Type)]
pub struct TeamProvider {
    pub id: String,
    pub name: String,
    pub installed: bool,
}

#[tauri::command]
#[specta::specta]
pub async fn list_team_providers(
    app_state: State<'_, Arc<AppState>>,
    connection: crate::acp::ConnectionKey,
) -> Result<Vec<TeamProvider>, String> {
    crate::acp::discovery_handlers::ensure_connection_server(&app_state, connection).await?;
    let agents =
        crate::acp::query_list_agents_via_connection_server(connection, &app_state).await?;
    let detected =
        crate::acp::manager::query_detect_installed_via_server(connection, &app_state).await?;
    Ok(agents
        .into_iter()
        .map(|a| TeamProvider {
            installed: detected.agents.iter().any(|d| d.agent_id == a.id),
            id: a.id,
            name: a.name,
        })
        .collect())
}

#[tauri::command]
#[specta::specta]
pub async fn confirm_custom_project(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
) -> Result<(), String> {
    let (_project, conn) = crate::core::get_project_with_git_conn(&app_state, project_id)
        .await
        .map_err(|e| e.to_string())?;
    crate::core::project_storage::write_maestro_json(
        &conn,
        "custom-owner.json",
        &serde_json::json!({"identifier":"com.memocan040.maestro.custom"}),
    )
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn orchestration(
    app_state: State<'_, Arc<AppState>>,
    project_id: i32,
    operation: serde_json::Value,
) -> Result<maestro_protocol::OrchestrationSnapshot, String> {
    let value = query_project_store(
        &app_state,
        project_id,
        |project_path| {
            ServerRequest::Orchestration(OrchestrationRequest {
                project_path,
                operation,
            })
        },
        reply!(ServerResponse::OrchestrationOk(value) => value),
    )
    .await?;
    serde_json::from_value(value).map_err(|e| format!("Invalid orchestration reply: {e}"))
}
