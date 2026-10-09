use crate::acp::connection_server::{query_project_store, reply};
use crate::core::AppState;
use maestro_protocol::{OrchestrationRequest, ServerRequest, ServerResponse};
use std::sync::Arc;
use tauri::State;

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
