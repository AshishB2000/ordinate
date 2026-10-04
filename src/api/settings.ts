import { z } from 'zod';
import { byProjectId, FileToken, rpc, Uuid } from './contract';

// Settings (T2.14). Three kinds of channel, three scopes:
//
//   organization  the workspace's formats, calendar, branding, Assistant rules,
//                 dashboard themes and backups — one config per org, so a write
//                 is org ADMIN (it changes every member's figures and sheets);
//                 reads that every screen needs (themes, the logo) are any member.
//   project       the Share policy and the sensitivity review (privacy:*) — read
//                 by any member, decided by an editor, the policy by a project admin
//                 (it decides whether an export may carry personal data).
//   palette       `search:query` — record NAMES in one project, any member.
//
// Every input is strict: the handlers re-sanitize too (config.sanitize,
// themeModel, privacyStore), but an unknown key is a 400 here first.

const admin = <I extends z.ZodType>(input: I) => rpc({ access: 'admin', org: true, input });

/** Workspace formats (src/app/format.ts FormatPrefs) — a PARTIAL patch, merged over what is stored. */
const FormatsPatch = z.strictObject({
  locale: z.string().max(35).optional(),
  numberStyle: z.enum(['locale', 'comma_dot', 'dot_comma', 'space_comma', 'apostrophe_dot', 'plain_dot']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  currencyPosition: z.enum(['before', 'after']).optional(),
  dateFormat: z.enum(['short', 'medium', 'iso']).optional(),
  weekStart: z.number().int().min(0).max(6).optional(),
  fiscalYearStart: z.number().int().min(1).max(12).optional(),
  calendarType: z.enum(['gregorian', '445', '454', '544', 'iso']).optional(),
  yearEnd: z.enum(['nearest', 'last']).optional(),
  compact: z.boolean().optional(),
});

/** A theme record as the editor sends it; src/app/themeStore re-validates every token. */
const Theme = z.strictObject({
  id: Uuid.optional(),
  name: z.string().max(200),
  tokens: z.record(z.string().regex(/^--[a-z0-9-]{1,40}$/), z.union([z.string().max(200), z.number()])),
});

const Level = z.enum(['personal', 'financial', 'none']);
const Action = z.enum(['mask', 'drop', 'include']);

export const settings = {
  // ── Organization: formats, branding, the Assistant's rules, notifications ──
  // preload: setFormats(patch) — src/ipc/prefs.ts; config re-sanitizes the merge.
  'formats:set': admin(FormatsPatch),
  // preload: setBranding(patch) — the accent ('' = the app's own blue) and the
  // style new dashboards start as. `logo` is not the browser's to set.
  'branding:set': admin(
    z.strictObject({
      accent: z.union([z.literal(''), z.string().regex(/^#[0-9a-f]{6}$/)]).optional(),
      dashboardStyle: z.enum(['auto', 'clean', 'executive', 'dense', 'dark']).optional(),
    }),
  ),
  // preload: brandingLogo('workspace') — a data: URL, never a path. Only the
  // workspace scope here; a dashboard's own logo ports with its screen (T2.9).
  'branding:logo': rpc({ access: 'read', org: true, input: z.literal('workspace') }),
  'branding:clearLogo': admin(z.literal('workspace')),
  // Server form of branding:pickLogo: the PNG/SVG was uploaded through POST
  // /api/files first; validated by content (src/app/branding.ts), 512 KB cap.
  'branding:setLogo': admin(z.strictObject({ fileToken: FileToken })),
  // preload: calendarToday() — the Calendar preview: today's period label and
  // this fiscal / ISO year's range under the workspace calendar, the server's
  // own answer (src/ipc/periods.ts; the calendar math is analysis/retailCalendar).
  'calendar:today': rpc({ access: 'read', org: true, input: z.undefined() }),
  // preload: setRules({ text }) — appended to every analysis's system prompt.
  'rules:set': admin(z.strictObject({ text: z.string().max(20_000) })),
  // preload: setAutoRefresh(on) — the org's dataset refresh schedule, on or off.
  'autorefresh:set': admin(z.boolean()),
  // preload: setNotifications({ fields }). On the server only the two the org's
  // alert rules read: whether a firing rule is pushed, and explained by a model.
  'notifications:set': admin(
    z.strictObject({ fields: z.strictObject({ alerts: z.boolean().optional(), alertExplain: z.boolean().optional() }) }),
  ),

  // ── Organization: dashboard themes (src/ipc/themes.ts) ─────────────────
  // Every dashboard reads them, so any member lists; writing one restyles the
  // org's sheets, so an admin writes.
  'themes:list': rpc({ access: 'read', org: true, input: z.undefined() }),
  'themes:save': admin(Theme),
  'themes:delete': admin(Uuid),
  'themes:setDefault': admin(z.union([Uuid, z.literal('')])),

  // ── Organization: backups (server only, src/ipc/settingsServer.ts) ─────
  // Every project of the org as one download (T0.4 token). Unmasked — a backup
  // must restore what was there — so org admin, and audited like every admin call.
  'backups:download': admin(z.undefined()),
  // A downloaded backup, uploaded again: each project comes back as a NEW
  // project. `confirm` is the word the admin typed — the server checks it too.
  'backups:restore': admin(z.strictObject({ fileToken: FileToken, confirm: z.literal('restore') })),

  // ── Project: privacy (src/ipc/privacy.ts) ───────────────────────────────
  // Settings → Privacy: the policy, every dataset's marked columns, pending proposals.
  'privacy:overview': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid }), project: byProjectId }),
  // Whether exports, reports, publish and bundles mask, drop or include a
  // sensitive column — loosening it is a project admin's call.
  'privacy:setPolicy': rpc({
    access: 'admin',
    input: z.strictObject({
      projectId: Uuid,
      policy: z.strictObject({ export: Action.optional(), report: Action.optional(), publish: Action.optional(), bundle: Action.optional() }),
    }),
    project: byProjectId,
  }),
  // One dataset's pending proposals and the levels already on its columns (the dataset page's banner).
  'privacy:review': rpc({ access: 'read', input: z.strictObject({ projectId: Uuid, datasetId: Uuid }), project: byProjectId }),
  // Marking a column (or "not sensitive") writes the catalog: an editor's call.
  'privacy:decide': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetId: Uuid, column: z.string().min(1).max(500), level: Level }),
    project: byProjectId,
  }),
  // Detect again over the stored tables (writes proposals, never levels).
  'privacy:scan': rpc({
    access: 'write',
    input: z.strictObject({ projectId: Uuid, datasetIds: z.array(Uuid).max(1000).optional() }),
    project: byProjectId,
  }),
  // "2 sensitive columns will be masked" — the line an export dialog shows.
  'privacy:summary': rpc({
    access: 'read',
    input: z.strictObject({
      projectId: Uuid,
      path: z.enum(['export', 'report', 'publish', 'bundle']),
      datasetIds: z.array(Uuid).max(1000).nullable(),
    }),
    project: byProjectId,
  }),

  // ── The command palette ─────────────────────────────────────────────────
  // preload: searchWorkspace(projectId, query) — record NAMES (never row
  // contents) in one project. The desktop's '' = every project is not offered:
  // the browser asks in the project it is in.
  'search:query': rpc({
    access: 'read',
    input: z.strictObject({ projectId: Uuid, query: z.string().max(200) }),
    project: byProjectId,
  }),
} as const;
