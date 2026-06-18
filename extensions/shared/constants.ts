/**
 * Constants shared between the todo and plan-flow extensions.
 *
 * These customType strings identify branch entries that both extensions read.
 * They MUST stay identical across extensions (plan-flow seeds todo state and
 * todo reads plan state to enforce plan-owned policy), so they live here in a
 * dependency-free module that neither extension imports the other through.
 */

/** customType for persisted plan-flow state snapshots. */
export const PLAN_STATE_CUSTOM_TYPE = "yuki-plan-flow-state";

/** customType for persisted todo state snapshots. */
export const TODO_STATE_CUSTOM_TYPE = "yuki-todo-state";

/** customType for yuki compaction runtime deltas. */
export const COMPACTION_STATE_CUSTOM_TYPE = "yuki-compaction-state";
