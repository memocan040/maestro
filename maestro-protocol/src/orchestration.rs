use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(deny_unknown_fields)]
pub struct TeamMember {
    pub id: String,
    pub profile_id: String,
    pub name: String,
    pub strengths: String,
    pub enabled: bool,
    pub orchestrator: bool,
    pub worker: bool,
    pub reviewer: bool,
    pub max_sessions: usize,
    pub priority: i32,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(deny_unknown_fields)]
pub struct PlannedTask {
    pub key: String,
    pub title: String,
    pub instructions: String,
    pub acceptance: Vec<String>,
    pub member_id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct Feature {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub acceptance: Vec<String>,
    pub orchestrator_member: String,
    pub orchestrator_task: i32,
    pub allowed_members: Vec<String>,
    pub max_parallel: usize,
    pub base_branch: String,
    pub integration_branch: String,
    pub status: String,
    pub plan: Vec<PlannedTask>,
    pub task_ids: Vec<i32>,
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
pub enum OrchestrationOperation {
    Snapshot,
    SaveMember {
        member: TeamMember,
    },
    CreateFeature {
        title: String,
        goal: String,
        acceptance: Vec<String>,
        orchestrator_member: String,
        allowed_members: Vec<String>,
        max_parallel: usize,
        base_branch: String,
    },
    SubmitPlan {
        feature_id: String,
        tasks: Vec<PlannedTask>,
    },
    ApprovePlan {
        feature_id: String,
    },
    Control {
        feature_id: String,
        command: String,
    },
    Message {
        feature_id: String,
        recipient_task: Option<i32>,
        kind: String,
        body: String,
        dedupe_key: String,
    },
    Acknowledge {
        message_id: String,
    },
    RecordIntegration {
        task_id: i32,
        commit_sha: String,
    },
    RetryMessage {
        message_id: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct FeatureMessage {
    pub id: String,
    pub feature_id: String,
    pub sender_task: Option<i32>,
    pub recipient_task: i32,
    pub kind: String,
    pub body: String,
    pub state: String,
    pub created_at: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(feature = "bindings", derive(specta::Type))]
pub struct OrchestrationSnapshot {
    pub members: Vec<TeamMember>,
    pub features: Vec<Feature>,
    pub messages: Vec<FeatureMessage>,
}
