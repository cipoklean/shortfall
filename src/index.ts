import { uiResolver } from './resolvers';
import { enqueueSync, runSyncJob } from './sync';
import {
  actionGetActiveShortages,
  actionGetShortageImpact,
  actionGetPastResponses,
  actionGetResponseStatus,
  actionDraftClinicianMessage,
  actionCreateResponseTask,
} from './actions';

/** UI resolver definitions for the Custom UI resources. */
export const handler = uiResolver;

/** Daily scheduled trigger: enqueue the sync rather than running inline. */
export const syncScheduled = async () => {
  await enqueueSync('scheduled');
  return { queued: true };
};

/** Async queue consumer: the actual sync + impact + response pipeline. */
export const syncWorker = async (event: { body?: { kind?: string } }) => {
  await runSyncJob(event?.body?.kind ?? 'scheduled');
  return { done: true };
};

/**
 * Byline dynamic properties: rename the byline entry to name the shortage
 * when this page is in an active impact map.
 */
export const bylineProps = async (
  _payload: unknown,
  context: { extension?: { content?: { id?: string } } },
) => {
  const { getPageNoticeData } = await import('./resolvers');
  const notice = await getPageNoticeData(context?.extension?.content?.id);
  if (notice.affected && notice.shortages?.length) {
    return {
      title: `Shortage: ${notice.shortages[0].name}`,
      tooltip: 'This page names a drug on the FDA shortage list',
    };
  }
  return { title: 'Shortfall', tooltip: 'Drug shortage status for this page' };
};

export { webSync, webReport } from './webtrigger';

/** Byline popup data (invoked from the byline resource by function key). */
export const bylineData = async (req: { payload?: { pageId?: string }; pageId?: string }) => {
  const { getPageNoticeData } = await import('./resolvers');
  return getPageNoticeData(req?.payload?.pageId ?? req?.pageId);
};

export const getActiveShortages = actionGetActiveShortages;
export const getShortageImpact = actionGetShortageImpact;
export const getPastResponses = actionGetPastResponses;
export const getResponseStatus = actionGetResponseStatus;
export const draftClinicianMessage = actionDraftClinicianMessage;
export const createResponseTask = actionCreateResponseTask;
