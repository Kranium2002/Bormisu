/**
 * Planned lines in the store (fictional data): upload shows the line, flies to its band and makes the
 * hits the active result set (pins highlighted) without a selected area; the distance and "Include
 * unreviewed" ask again with the right parameters; epsg_required keeps the server's code; an older
 * answer is ignored; clear and delete take the line and its set away; earlier lines are listed.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AlignmentQueryOptions, AlignmentUploadOptions } from '../data/DataSource';
import { ApiError } from '../data/errors';
import type { Alignment, AlignmentResult, ResultSet } from '../domain/types';
import { makeBorehole, makeDocument } from '../test/fixtures';
import { DEFAULT_BUFFER_M } from './alignmentSlice';
import { useAppStore } from './appStore';
import { fakeSource, readyStore } from './testing';

const st = () => useAppStore.getState();

const A = makeBorehole({ uid: 'bh_TEST_LINE_00000000000001', id: 'TL-1', lat: 50.2105, lng: 9.421, reviewStatus: 'approved' });
const B = makeBorehole({ uid: 'bh_TEST_LINE_00000000000002', id: 'TL-2', lat: 50.2098, lng: 9.4262, reviewStatus: 'approved' });

const LINE: Alignment = {
  id: 'aln_TEST_1',
  name: 'Fictional line',
  fileName: 'line.geojson',
  format: 'geojson',
  sourceCrs: 'EPSG:4326',
  parts: [
    [
      [9.4137, 50.208],
      [9.4325, 50.2094],
    ],
  ],
  lengthM: 1432,
  vertexCount: 2,
  partCount: 1,
  bbox: [9.4137, 50.208, 9.4325, 50.2094],
  bufferM: 100,
  createdAt: '2026-10-17T18:00:00Z',
};

const BAND: [number, number][][][] = [
  [
    [
      [9.41, 50.207],
      [9.436, 50.207],
      [9.436, 50.211],
      [9.41, 50.211],
      [9.41, 50.207],
    ],
  ],
];

function resultSet(uids: string[], id = 'rs_TEST_LINE_1'): ResultSet {
  return {
    id,
    count: uids.length,
    locatedCount: uids.length,
    unlocatedCount: 0,
    excludedUnreviewed: 0,
    uids,
    bbox: [9.421, 50.2098, 9.4262, 50.2105],
    area: { type: 'polygon', polygon: { type: 'Polygon', coordinates: BAND[0] } },
    definition: {
      search: null, country: null, project: null, documentId: null, minDepth: null, maxDepth: null, dinCodes: [],
      lithologyMinDepth: null, hasSpt: null, hasGroundwater: null, reviewStatus: [], includeUnreviewed: false, area: null,
    },
    createdAt: '2026-10-17T18:00:01Z',
  };
}

function lineResult(o: Partial<AlignmentResult> = {}, uids = [A.uid, B.uid]): AlignmentResult {
  return {
    alignmentId: LINE.id,
    bufferM: 100,
    includeUnreviewed: false,
    lengthM: 1432,
    metricCrs: 'EPSG:32632',
    band: BAND,
    hits: uids.map((uid, i) => ({
      uid, id: `TL-${i + 1}`, documentId: 'doc_TEST0000000000000000000001', project: null, depth: 10, reviewStatus: 'approved' as const,
      crsStatus: 'confirmed', lat: 50.21, lng: 9.42 + i / 100, offsetM: 40 + i, chainageM: 589 + 400 * i, side: i ? ('right' as const) : ('left' as const),
    })),
    excludedUnreviewed: 2,
    notOnMap: 1,
    resultSet: resultSet(uids),
    ...o,
  };
}

/** A source whose line answers come from `answer`, with the result sets it issued known to resultSetFeatures. */
async function ready(answer: (id: string, q: AlignmentQueryOptions) => Promise<AlignmentResult> = async () => lineResult()) {
  const issued = new Map<string, ResultSet>();
  const uploadAlignment = vi.fn(async (_file: File, _o?: AlignmentUploadOptions) => LINE);
  const queryAlignment = vi.fn(async (id: string, q: AlignmentQueryOptions) => {
    const r = await answer(id, q);
    issued.set(r.resultSet.id, r.resultSet);
    return r;
  });
  const deleteAlignment = vi.fn(async () => undefined);
  const source = fakeSource(
    { boreholes: [A, B], documents: [makeDocument()] },
    {
      uploadAlignment,
      queryAlignment,
      deleteAlignment,
      listAlignments: async () => [LINE],
      getAlignment: async () => LINE,
      resultSetFeatures: async (id) => {
        const rs = issued.get(id);
        const all = (await source.mapFeatures()) ?? [];
        return all.filter((f) => rs?.uids.includes(f.uid));
      },
    },
  );
  await readyStore(source);
  st().go('map');
  return { uploadAlignment, queryAlignment, deleteAlignment };
}

const file = () => new File(['{}'], 'line.geojson', { type: 'application/geo+json' });

describe('planned line: upload and show', () => {
  it('uploads with the current distance, asks for the hits (unreviewed included, as on the map), flies to the band and shows the hits as the result set', async () => {
    const { uploadAlignment, queryAlignment } = await ready();
    expect(st().alignmentBufferM).toBe(DEFAULT_BUFFER_M);
    expect(st().alignmentIncludeUnreviewed).toBe(true);
    const before = st().mapOutline?.nonce ?? 0;
    expect(await st().uploadAlignment(file(), { epsg: 25832 })).toBe(true);
    expect(uploadAlignment).toHaveBeenCalledWith(expect.any(File), { epsg: 25832, bufferM: 100 });
    expect(queryAlignment).toHaveBeenCalledWith(LINE.id, { bufferM: 100, includeUnreviewed: true });
    expect(st().alignment?.id).toBe(LINE.id);
    expect(st().alignmentResult?.hits.map((h) => h.uid)).toEqual([A.uid, B.uid]);
    expect(st().alignmentBusy).toBeNull();
    expect(st().alignments?.map((a) => a.id)).toEqual([LINE.id]);
    // The band's bounds, not the hits'.
    expect(st().mapOutline).toMatchObject({ bbox: [9.41, 50.207, 9.436, 50.211], outline: false });
    expect(st().mapOutline!.nonce).toBeGreaterThan(before);
    // The hits are the active result set (pins highlighted), without a selected area; the filter panel is untouched.
    expect(st().resultSet?.id).toBe('rs_TEST_LINE_1');
    expect(st().resultSet?.uids).toEqual([A.uid, B.uid]);
    expect(st().resultSet?.area).toBeNull();
    expect(st().resultSetFeatures?.map((f) => f.uid).sort()).toEqual([A.uid, B.uid].sort());
    expect(st().filter.area).toBeNull();
  });

  it('epsg_required: nothing is shown, the error keeps the code and the server’s detail', async () => {
    const { uploadAlignment } = await ready();
    uploadAlignment.mockRejectedValueOnce(new ApiError(422, 'epsg_required', 'The CSV has x/y columns. Give the EPSG code.'));
    expect(await st().uploadAlignment(new File(['x;y'], 'line.csv'))).toBe(false);
    expect(st().alignment).toBeNull();
    expect(st().alignmentError).toEqual({ code: 'epsg_required', text: 'The CSV has x/y columns. Give the EPSG code.' });
    expect(st().alignmentBusy).toBeNull();
  });

  it('a query that fails shows its detail; the line stays', async () => {
    await ready(async () => {
      throw new ApiError(422, 'validation_error', 'The request is not valid.');
    });
    await st().uploadAlignment(file());
    expect(st().alignment?.id).toBe(LINE.id);
    expect(st().alignmentResult).toBeNull();
    expect(st().alignmentError?.text).toBe('The request is not valid.');
  });
});

describe('planned line: distance and review scope', () => {
  it('the distance and Include unreviewed ask again with their values; an invalid distance changes nothing', async () => {
    const { queryAlignment } = await ready(async (_id, q) => lineResult({ bufferM: q.bufferM ?? 100, includeUnreviewed: q.includeUnreviewed }));
    await st().uploadAlignment(file());
    await st().setAlignmentBuffer(150);
    expect(queryAlignment).toHaveBeenLastCalledWith(LINE.id, { bufferM: 150, includeUnreviewed: true });
    await st().setAlignmentIncludeUnreviewed(false);
    expect(queryAlignment).toHaveBeenLastCalledWith(LINE.id, { bufferM: 150, includeUnreviewed: false });
    expect(st().alignmentResult).toMatchObject({ bufferM: 150, includeUnreviewed: false });
    const calls = queryAlignment.mock.calls.length;
    await st().setAlignmentBuffer(0);
    await st().setAlignmentBuffer(1001);
    expect(queryAlignment.mock.calls.length).toBe(calls);
    expect(st().alignmentBufferM).toBe(150);
  });

  it('an older answer that comes last is ignored', async () => {
    let release!: () => void;
    const slow = new Promise<void>((resolve) => {
      release = resolve;
    });
    let n = 0;
    await ready(async (_id, q) => {
      n += 1;
      if (n === 2) await slow; // the 120 m question answers after the 150 m one
      return lineResult({ bufferM: q.bufferM ?? 100 }, [A.uid]);
    });
    await st().uploadAlignment(file());
    const first = st().setAlignmentBuffer(120);
    await st().setAlignmentBuffer(150);
    release();
    await first;
    expect(st().alignmentResult?.bufferM).toBe(150);
    expect(st().alignmentBufferM).toBe(150);
  });
});

describe('planned line: clear, delete, earlier lines', () => {
  it('CLEAR takes the line and its result set off the map; another result set is left alone', async () => {
    await ready();
    await st().uploadAlignment(file());
    st().clearAlignment();
    expect(st().alignment).toBeNull();
    expect(st().alignmentResult).toBeNull();
    expect(st().resultSet).toBeNull();
  });

  it('DELETE removes the line from the list and clears it when shown', async () => {
    const { deleteAlignment } = await ready();
    await st().listAlignments();
    expect(st().alignments?.map((a) => a.id)).toEqual([LINE.id]);
    await st().uploadAlignment(file());
    await st().deleteAlignment(LINE.id);
    expect(deleteAlignment).toHaveBeenCalledWith(LINE.id);
    expect(st().alignments).toEqual([]);
    expect(st().alignment).toBeNull();
    expect(st().resultSet).toBeNull();
  });

  it('an earlier line opens with its own distance', async () => {
    const { queryAlignment } = await ready();
    await st().listAlignments();
    useAppStore.setState({ alignments: [{ ...LINE, bufferM: 250 }] });
    await st().openAlignment(LINE.id);
    expect(st().alignmentBufferM).toBe(250);
    expect(queryAlignment).toHaveBeenLastCalledWith(LINE.id, { bufferM: 250, includeUnreviewed: true });
    expect(st().alignment?.id).toBe(LINE.id);
  });

  it('drawing: one flag, set and cleared', async () => {
    await ready();
    st().setAlignmentDrawing(true);
    expect(st().alignmentDrawing).toBe(true);
    st().setAlignmentDrawing(false);
    expect(st().alignmentDrawing).toBe(false);
  });
});
