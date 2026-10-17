/**
 * Test helper for server-rendered components that read the store (fictional data only; not used by
 * the app). Server rendering reads a zustand store's initial state, which a test cannot set; the
 * component tests therefore replace src/store/appStore with mockAppStore, whose hooks read the real
 * initial state plus `testStore.state`, and whose usePage reads `testStore.pages`:
 *
 *   vi.mock('../../store/appStore', async (importOriginal) =>
 *     (await import('../../components/clarify/testStore')).mockAppStore(await importOriginal()));
 */
import type * as AppStoreModule from '../../store/appStore';
import type { AppState, PageLoad } from '../../store/types';

/** What the mocked store holds on top of the real initial state; tests set it before rendering. */
export const testStore: { state: Partial<AppState>; pages: Record<string, PageLoad> } = { state: {}, pages: {} };

/** Resets testStore (call in beforeEach). */
export function resetTestStore(state: Partial<AppState> = {}): void {
  testStore.state = state;
  testStore.pages = {};
}

const noop = () => undefined;
const noopAsync = async () => undefined;

/** Clarification and map-data defaults, so components render whether or not the store has those slices yet. */
const SLICE_DEFAULTS: Partial<AppState> = {
  clarifications: [],
  clarificationsState: 'idle',
  activeClarificationId: null,
  loadClarifications: noopAsync,
  openClarification: noop,
  closeClarification: noop,
  answerClarification: async () => ({ ok: true }),
  skipClarification: noopAsync,
  features: [],
  unplottedUids: [],
};

const LOADING: PageLoad = { status: 'loading' };
const NO_PAGE: PageLoad = { status: 'error', error: 'No source page for this value' };

/** The replacement of src/store/appStore (see the file comment). */
export function mockAppStore(actual: typeof AppStoreModule): typeof AppStoreModule {
  const read = () => ({ ...SLICE_DEFAULTS, ...actual.useAppStore.getInitialState(), ...testStore.state }) as AppState;
  const hook = <T>(selector: (s: AppState) => T): T => selector(read());
  const useAppStore = Object.assign(hook, actual.useAppStore, { getState: read, getInitialState: read }) as unknown as typeof actual.useAppStore;
  return {
    ...actual,
    useAppStore,
    useBorehole: (uid) => (uid ? read().boreholes.find((b) => b.uid === uid) : undefined),
    useValue: (uid, key) => (uid && key ? read().boreholes.find((b) => b.uid === uid)?.values.find((v) => v.key === key) : undefined),
    useDocument: (id) => (id ? read().documents.find((d) => d.id === id) : undefined),
    useReviewBorehole: () => read().boreholes.find((b) => b.uid === read().reviewUid),
    useSelectedBorehole: () => read().boreholes.find((b) => b.uid === read().selectedUid),
    useHealth: () => read().health,
    usePage: (documentId, page) => (documentId && page ? (testStore.pages[`${documentId}:${page}`] ?? LOADING) : NO_PAGE),
  };
}
