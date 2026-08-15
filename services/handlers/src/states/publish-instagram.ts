import type { WorkflowState } from '@mrp/shared';

import {
  checkPublishStatus,
  createPublishContainer,
  finalisePublish,
  recordPublishFailure,
  type PublishBranchState,
} from './publish.js';

/**
 * Instagram branch entrypoints.
 *
 * Separate Lambda handlers rather than one, so each phase is its own Step
 * Functions state with its own retry policy, timeout and CloudWatch metrics.
 */

const asBranch = (state: WorkflowState): PublishBranchState => ({
  ...state,
  platform: 'instagram',
});

export const createContainerHandler = async (
  state: WorkflowState,
): Promise<PublishBranchState> => createPublishContainer(asBranch(state));

export const checkStatusHandler = async (state: WorkflowState): Promise<PublishBranchState> =>
  checkPublishStatus(asBranch(state));

export const publishHandler = async (state: WorkflowState): Promise<PublishBranchState> =>
  finalisePublish(asBranch(state));

export const failureHandler = async (
  state: WorkflowState & { error?: { Error?: string; Cause?: string } },
): Promise<PublishBranchState> =>
  recordPublishFailure({ ...asBranch(state), error: state.error });
