/**
 * The chat drawer in API mode (FRONTEND.md F14, F15) with Playwright route interception: no model is
 * ever called. Health is the backend's own answer with providers.chat switched on; POST /chat is
 * answered with the recorded fictional streams of contracts/examples/chat (turn.sse, error.sse) as
 * the backend sends them (text/event-stream, x-vercel-ai-ui-message-stream: v1). The ids of the
 * recorded turn (its result set, its cited borehole and report) are not in the seeded stack, so their
 * answers come from the contract's fictional examples (contracts/examples) through routes too.
 *
 * Without the switch, the backend's own health (no chat model) and a 409 chat_unavailable answer
 * show the chat as not configured.
 *
 * Seed state needed: any (the seeded stack's pins stay as they are). Read-only.
 */
import type { Page, Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { API, expect, expectConsoleErrors, openApp, test } from './fixtures';

const EXAMPLES = new URL('../../../contracts/examples/', import.meta.url);
const example = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(new URL(name, EXAMPLES), 'utf8')) as T;
const TURN = readFileSync(new URL('chat/turn.sse', EXAMPLES), 'utf8');
const ERROR = readFileSync(new URL('chat/error.sse', EXAMPLES), 'utf8');

/** Ids of the recorded turn (fictional). */
const RS = 'rs_01M54KQD30FJP214PJ45PFT70T';
const UID = 'bh_01M54CB4HGT2NXJXQZD6BE0FGK';
const DOC = 'doc_01M54BPP80DBVM60TJD6V5NPM0';
const TEXT_START = 'One uploaded borehole near Lindenwick goes deeper than 15 m: FHL-BH01, 18.00 m deep';
const NOT_CONFIGURED = 'Chat is not configured on the server (no OpenAI key)';

/** A 1×1 light-grey PNG (the cited page's image). */
const BLANK_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC', 'base64');

interface WireFeatureCollection { type: 'FeatureCollection'; features: { properties: { uid: string } }[] }

/** The fictional pin of the cited borehole (contract example). */
const fictionalFeatures = (): WireFeatureCollection => {
  const fc = example<WireFeatureCollection>('BoreholeFeatureCollection.json');
  return { ...fc, features: fc.features.filter((f) => f.properties.uid === UID) };
};

/** The recorded turn's result set as GET /result-sets/{id} answers (fictional, from the contract example). */
const resultSet = () => ({
  ...example('ResultSet.located.json'),
  result_set_id: RS,
  count: 1,
  located_count: 1,
  unlocated_count: 0,
  uids: [UID],
  bbox: [8.505846, 53.875923, 8.505846, 53.875923],
  area: { type: 'bbox', bbox: [8.47, 53.85, 8.53, 53.89] },
  definition: { min_depth_m: 15.0, include_unreviewed: true, area: { type: 'bbox', bbox: [8.47, 53.85, 8.53, 53.89] } },
});

const sse = (body: string) => ({
  status: 200,
  headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1', 'cache-control': 'no-cache' },
  body,
});

/**
 * Health with the chat model switched on, and the recorded turn's ids answered from the contract's
 * fictional examples: its result set and members, the cited borehole (its pin joins the stack's
 * pins), its report and the cited page's image.
 */
async function chatStack(page: Page): Promise<void> {
  await page.route(`**${API}/health`, async (route) => {
    const res = await route.fetch();
    const health = (await res.json()) as { providers: Record<string, boolean> };
    await route.fulfill({ response: res, json: { ...health, providers: { ...health.providers, chat: true } } });
  });
  await page.route(/\/api\/v1\/map\/boreholes\.geojson/, async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('document_id') === DOC) return route.fulfill({ json: fictionalFeatures() });
    const res = await route.fetch();
    const fc = (await res.json()) as WireFeatureCollection;
    const extra = url.searchParams.get('document_id') ? [] : fictionalFeatures().features;
    await route.fulfill({ response: res, json: { ...fc, features: [...fc.features, ...extra] } });
  });
  await page.route(`**${API}/result-sets/${RS}`, (route) => route.fulfill({ json: resultSet() }));
  await page.route(`**${API}/result-sets/${RS}/geojson`, (route) => route.fulfill({ json: fictionalFeatures() }));
  await page.route(`**${API}/boreholes/${UID}`, (route) => route.fulfill({ json: example('BoreholeRecord.full.json') }));
  await page.route(`**${API}/documents/${DOC}`, (route) => route.fulfill({ json: example('Document.needs_review.json') }));
  await page.route(new RegExp(`/api/v1/documents/${DOC}/pages/\\d+\\.png`), (route) =>
    route.fulfill({ status: 200, contentType: 'image/png', body: BLANK_PNG }),
  );
}

/** Answers POST /chat with `answer` (one per request, the last one repeated), recording the request bodies. */
async function chatAnswers(page: Page, ...answers: ((route: Route) => Promise<void>)[]): Promise<Record<string, unknown>[]> {
  const bodies: Record<string, unknown>[] = [];
  await page.route(`**${API}/chat`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>);
    const answer = answers[Math.min(bodies.length, answers.length) - 1];
    await answer(route);
  });
  return bodies;
}

const chatButton = (page: Page) => page.getByRole('button', { name: 'CHAT', exact: true });
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Chat assistant' });
const question = (page: Page) => drawer(page).getByRole('textbox', { name: 'Your question' });
const mapRegion = (page: Page) => page.getByRole('region', { name: 'Borehole map' });

async function ask(page: Page, text: string): Promise<void> {
  await question(page).fill(text);
  await question(page).press('Enter');
}

async function openChat(page: Page): Promise<void> {
  await expect(chatButton(page)).not.toHaveAttribute('aria-disabled', 'true');
  await chatButton(page).click();
  await expect(drawer(page)).toBeVisible();
  await expect(question(page)).toBeFocused();
}

test.describe('with a chat model (recorded fictional streams)', () => {
  test.beforeEach(async ({ page }) => {
    await chatStack(page);
  });

  test('the drawer streams the answer: progress lines, the result card, text with citation chip 1 and the scope line; the request carries the context', async ({ page }) => {
    const bodies = await chatAnswers(page, (route) => route.fulfill(sse(TURN)));
    await openApp(page);
    await openChat(page);
    await drawer(page).getByRole('switch', { name: 'Include unreviewed' }).click();
    await ask(page, 'Which boreholes near Lindenwick go deeper than 15 m?');

    const d = drawer(page);
    await expect(d.getByText('Which boreholes near Lindenwick go deeper than 15 m?')).toBeVisible();
    await expect(d.getByText(TEXT_START)).toBeVisible();
    for (const line of ['Finding the place', 'Searching boreholes', 'Reading the evidence']) await expect(d.getByText(line, { exact: true })).toBeVisible();
    await expect(d.locator(`[data-chat-result-set="${RS}"]`)).toContainText('1 borehole · 1 on the map');
    await expect(d.getByRole('button', { name: 'Source 1: page 7, “Endteufe 18,00 m”' })).toHaveText('1');
    await expect(d.getByText('Scope: accepted and unreviewed data · 3 documents still processing')).toBeVisible();
    await expect(d.getByRole('button', { name: 'SEND' })).toBeVisible();

    // The request: the contract's ChatRequest with the context of the moment.
    expect(bodies).toHaveLength(1);
    const body = bodies[0] as { id: string; messages: { role: string; parts: { type: string; text?: string }[] }[]; context: Record<string, unknown> };
    expect(typeof body.id).toBe('string');
    expect(body.messages.at(-1)).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Which boreholes near Lindenwick go deeper than 15 m?' }] });
    expect(body.context).toMatchObject({ units: 'm', include_unreviewed: true, map_view: null, selected_uids: [] });
    expect(typeof body.context.ui_language).toBe('string');

    // The UI commands of the turn (show_result_set, fit_result_set) showed the set on the map.
    await expect(page).toHaveURL(new RegExp(`[?&]rs=${RS}`));
    await expect(mapRegion(page)).toHaveAttribute('data-members', '1');
  });

  test('SHOW ON MAP shows the set on the map from another screen; OPEN TABLE as well', async ({ page }) => {
    await chatAnswers(page, (route) => route.fulfill(sse(TURN)));
    await openApp(page);
    await openChat(page);
    await ask(page, 'Which boreholes near Lindenwick go deeper than 15 m?');
    await expect(drawer(page).getByText(TEXT_START)).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`[?&]rs=${RS}`));

    // Away from the map (the drawer stays open across screens), SHOW ON MAP brings the map back with the set.
    await page.getByRole('link', { name: /^UPLOAD & QUEUE/ }).click();
    await expect(page).toHaveURL(/\/queue/);
    await expect(mapRegion(page)).toHaveCount(0);
    await drawer(page).getByRole('button', { name: 'SHOW ON MAP' }).click();
    await expect(page).toHaveURL(new RegExp(`/map\\?.*rs=${RS}`));
    await expect(mapRegion(page)).toHaveAttribute('data-members', '1');

    await page.getByRole('link', { name: /^UPLOAD & QUEUE/ }).click();
    await expect(page).toHaveURL(/\/queue/);
    await drawer(page).getByRole('button', { name: 'OPEN TABLE' }).click();
    await expect(page).toHaveURL(new RegExp(`/map\\?.*rs=${RS}`));
    await expect(mapRegion(page)).toHaveAttribute('data-members', '1');
  });

  test('a citation chip opens the Source panel at the cited value (page 7); the drawer stays usable beside it', async ({ page }) => {
    await chatAnswers(page, (route) => route.fulfill(sse(TURN)));
    await openApp(page);
    await openChat(page);
    await ask(page, 'How deep is FHL-BH01?');
    await drawer(page).getByRole('button', { name: /^Source 1:/ }).click();
    const source = page.getByRole('dialog', { name: 'Source' });
    await expect(source).toBeVisible();
    await expect(source).toContainText('SOURCE ·');
    await expect(source).toContainText('page 7');
    await expect(source).toContainText('Endteufe 18,00 m');
    // Both visible: the drawer moved left of the panel.
    const panelBox = await source.boundingBox();
    const drawerBox = await drawer(page).boundingBox();
    expect(panelBox && drawerBox && drawerBox.x + drawerBox.width <= panelBox.x + 1).toBe(true);
    await expect(question(page)).toBeEnabled();
  });

  test('an error in the stream shows its text with RETRY; RETRY asks again and the answer comes', async ({ page }) => {
    const bodies = await chatAnswers(
      page,
      (route) => route.fulfill(sse(ERROR)),
      (route) => route.fulfill(sse(TURN)),
    );
    await openApp(page);
    await openChat(page);
    await ask(page, 'Which boreholes near Lindenwick go deeper than 15 m?');
    const alert = drawer(page).getByRole('alert');
    await expect(alert).toContainText('The chat model did not answer in time. Please try again.');
    await alert.getByRole('button', { name: 'RETRY' }).click();
    await expect(drawer(page).getByText(TEXT_START)).toBeVisible();
    await expect(drawer(page).getByRole('alert')).toHaveCount(0);
    expect(bodies).toHaveLength(2);
    expect(bodies[1].context).toEqual(bodies[0].context);
  });

  test('STOP ends an answer that is on its way', async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await chatAnswers(page, async (route) => {
      await held;
      await route.fulfill(sse(TURN)).catch(() => undefined);
    });
    await openApp(page);
    await openChat(page);
    await ask(page, 'Which boreholes near Lindenwick go deeper than 15 m?');
    const stop = drawer(page).getByRole('button', { name: 'STOP' });
    await expect(stop).toBeVisible();
    await stop.click();
    await expect(drawer(page).getByRole('button', { name: 'SEND' })).toBeVisible();
    await expect(drawer(page).getByRole('alert')).toHaveCount(0);
    release();
  });

  test('request_area: the map shows the prompt and draws; the rectangle goes to the chat as map_view of the next message, not to the selection', async ({ page }) => {
    // A fictional turn that asks for an area (contract 2.3 request_area).
    const askArea = [
      { type: 'start', messageId: 'msg_test_area' },
      { type: 'start-step' },
      { type: 'data-ui-command', transient: true, data: { command: 'request_area', args: { prompt: 'Draw the fictional area you mean.' } } },
      { type: 'text-start', id: 't1' },
      { type: 'text-delta', id: 't1', delta: 'Please draw the area on the map, then ask again.' },
      { type: 'text-end', id: 't1' },
      { type: 'finish-step' },
      { type: 'finish' },
    ]
      .map((c) => `data: ${JSON.stringify(c)}\n\n`)
      .join('') + 'data: [DONE]\n\n';
    const bodies = await chatAnswers(
      page,
      (route) => route.fulfill(sse(askArea)),
      (route) => route.fulfill(sse(TURN)),
    );
    const selections: string[] = [];
    page.on('request', (r) => {
      if (r.method() === 'POST' && new URL(r.url()).pathname === `${API}/result-sets`) selections.push(r.url());
    });
    await openApp(page);
    await openChat(page);
    await ask(page, 'How many boreholes are in this area?');
    const hint = mapRegion(page).locator('[data-chat-area-request]');
    await expect(hint).toContainText('Draw the fictional area you mean.');
    await expect(page.getByRole('button', { name: 'Select by rectangle' })).toHaveAttribute('aria-pressed', 'true');

    const box = (await mapRegion(page).boundingBox())!;
    await page.mouse.click(box.x + box.width * 0.12, box.y + box.height * 0.3);
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6, { steps: 4 });
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await expect(hint).toHaveCount(0);
    await expect(drawer(page).getByText('Area drawn on the map: it goes with your next message.')).toBeVisible();
    await expect(mapRegion(page).locator('[data-map-shape="area"]')).toHaveCount(1);

    await ask(page, 'How many boreholes are in this area?');
    await expect(drawer(page).getByText(TEXT_START)).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[0].context).toMatchObject({ map_view: null });
    const view = (bodies[1].context as { map_view: { bbox: number[]; zoom?: number } | null }).map_view;
    expect(view?.bbox).toHaveLength(4);
    const [minLon, minLat, maxLon, maxLat] = view!.bbox;
    expect(minLon).toBeLessThan(maxLon);
    expect(minLat).toBeLessThan(maxLat);
    // The area went with that message only, and never became an area selection.
    await expect(drawer(page).getByText('Area drawn on the map: it goes with your next message.')).toHaveCount(0);
    expect(selections).toEqual([]);
  });

  test('a 409 chat_unavailable answer shows the chat as not configured, in the drawer and on the button', async ({ page, errors }) => {
    await chatAnswers(page, (route) => route.fulfill({ status: 409, json: example('Error.chat_unavailable.json') }));
    await openApp(page);
    await openChat(page);
    await ask(page, 'Hello');
    await expect(drawer(page).getByRole('status').filter({ hasText: NOT_CONFIGURED })).toBeVisible();
    await expect(question(page)).toBeDisabled();
    await expect(drawer(page).getByRole('alert')).toHaveCount(0);
    await drawer(page).getByRole('button', { name: 'Close the chat' }).click();
    await expect(drawer(page)).toHaveCount(0);
    await expect(chatButton(page)).toHaveAttribute('aria-disabled', 'true');
    await expect(chatButton(page)).toHaveAttribute('title', NOT_CONFIGURED);
    // Chrome logs the 409 answer itself as a failed resource.
    expectConsoleErrors(errors, (e) => e.includes('409'));
  });
});

test('without a chat model on the server (health providers.chat false) the CHAT button is off with the reason', async ({ page }) => {
  await page.route(`**${API}/health`, async (route) => {
    const res = await route.fetch();
    const health = (await res.json()) as { providers: Record<string, boolean> };
    await route.fulfill({ response: res, json: { ...health, providers: { ...health.providers, chat: false } } });
  });
  await openApp(page);
  await expect(chatButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(chatButton(page)).toHaveAttribute('title', NOT_CONFIGURED);
  // Off (aria-disabled, so Playwright would wait for it): a forced click opens nothing.
  await chatButton(page).click({ force: true });
  await expect(drawer(page)).toHaveCount(0);
});
