export { discardCommitEdit, finishCommitEdit, followRewrites, isEditInProgress, locateLine, startCommitEdit } from './commitEdit';
export type { CommitEdit, EditLocation } from './commitEdit';
export { VcsError } from './exec';
export { GitAdapter } from './git';
export { JjAdapter } from './jj';
export type { JjCommit, LineOrigin } from './jj';
export type { FetchedCommits, FetchedMergeRequest, MergeRequestFetch, Remote } from './mergeRequests';
export { openRepository } from './repository';
export type { MergeRequestRepository, OpenOptions, Repository, VcsKind } from './repository';
