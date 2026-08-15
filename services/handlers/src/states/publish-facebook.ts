import type { WorkflowState } from '@mrp/shared';

import {
  checkPublishStatus,
  createPublishContainer,
  finalisePublish,
  recordPublishFailure,
  type PublishBranchState,
} from './publish.js';

/**
 * Facebook branch entrypoints.
 *
 * A completely separate publication transaction from Instagram: its own state
 * row, attempts and outcome. Publishing here never implies an Instagram post and
 * cross-posting is never assumed.
 */

const asBranch = (state: WorkflowState): PublishBranchState => ({
  ...state,
  platform: 'facebook',
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
