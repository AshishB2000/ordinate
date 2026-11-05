// The inventory behind scripts/test-definitionSites.ts: every file under src/ and web/src that branches on a metric
// definition's kind (the test's PATTERNS: `isFormulaDefinition(`, `'formula' in`, `.definition.column|aggregation|
// formula|snapshot`, `isExternalDefinition(`, and part 5's `isSimpleDefinition(`, `isFunnelDefinition(`,
// `isPeriodDefinition(`, `isNewerKind(`), with how many matches it has and what its sites do with an EXTERNAL
// definition (semantic layer part 7, b0: `{ external, additive?, layer? }`, a layer's metric by name). The test counts
// the matches in each file and fails on any difference, so a new site is classified here in the commit that adds it.
// Never raise a number to make the test pass.
//
// Part 5's funnel and period kinds (and a per-entity snapshot) are "pending" on this release: a site does with one
// what its row says it does with an external one, through ./pendingKinds instead of ./externalMetric (a KPI shows no
// figure, a chart or answer refuses with a sentence, a vocabulary leaves it out). A countd arm (`.definition.
// aggregation`) computes, but is not offered to a writer (`unofferedMetric`). `isSimpleDefinition(` narrows to a
// column metric, so an external one never reads as `sum of ''` there.
//
//   keeps     reads the kind for metadata only (a sanitizer, a formula's references, a date scope): an external one is
//             kept verbatim and reads as "not a formula", never as a column total
//   refuses   a figure path, a vocabulary or a lock check: an external one throws ExternalMetricError, is left out, or
//             is never allowed — never drawn as its stored column
//   words     says the kind in words ("Defined in another tool"), no figure
//   door      the KPI resolver and the chart planner: they refuse today, and b2 turns them into the layer's answers
//
// A file with sites of several kinds carries the strictest of them (door > refuses > keeps > words).

export type DefinitionSiteHow = 'keeps' | 'refuses' | 'words' | 'door';

export const DEFINITION_SITES: Readonly<Record<string, { count: number; how: DefinitionSiteHow }>> = {
  // door
  'src/analysis/metricMeasures.ts': { count: 25, how: 'door' }, // + a period measure charts alone, on its base (p5-06)
  'src/ipc/metrics.ts': { count: 10, how: 'door' }, // + a period metric resolves its base (p5-05)
  // refuses
  'src/ai/planExec.ts': { count: 1, how: 'refuses' }, // a plan step cannot name it
  'src/ipc/periodMetric.ts': { count: 3, how: 'refuses' }, // a period over an external base: its base's resolution throws ExternalMetricError
  'src/analysis/additivity.ts': { count: 14, how: 'refuses' }, // adds up nowhere (b2 reads `additive`); a period over an external base adds as it does
  'src/analysis/driverShape.ts': { count: 3, how: 'refuses' }, // key drivers: no members to split it into
  'src/analysis/metricTreeJs.ts': { count: 6, how: 'refuses' }, // the JS reference throws
  'src/analysis/scenarioResolve.ts': { count: 10, how: 'refuses' }, // behind resolveMetric's refusal; no column a driver moves
  'src/analysis/snapshotGuards.ts': { count: 5, how: 'refuses' }, // the answer door's measure check
  'src/ipc/answers.ts': { count: 5, how: 'refuses' }, // never a spec's column measure
  'src/ipc/copilot.ts': { count: 3, how: 'refuses' }, // left out of the Assistant's figures
  'src/ipc/drillScope.ts': { count: 2, how: 'refuses' }, // its rows are the layer's
  'src/ipc/drivers.ts': { count: 1, how: 'refuses' },
  'src/ipc/reportsServer.ts': { count: 1, how: 'refuses' }, // a story's metric block says why
  'src/ipc/scenarios.ts': { count: 5, how: 'refuses' }, // the picker leaves it out
  'src/ipc/stories.ts': { count: 4, how: 'refuses' }, // an inline KPI is never tied to it
  'src/ipc/summary.ts': { count: 1, how: 'refuses' }, // no sentence; the tile says why
  'src/app/modelExport.ts': { count: 1, how: 'refuses' }, // never in the model files, only listed as not carried (D13)
  'src/ipc/targetSeries.ts': { count: 1, how: 'refuses' }, // a plan as a chart measure: an external plan is refused by the chart door, so no line
  'src/publish/embedLock.ts': { count: 3, how: 'refuses' }, // never allowed under a lock
  // keeps
  'src/analysis/externalMetric.ts': { count: 2, how: 'keeps' }, // the kind and its whitelist
  'src/analysis/alertMetric.ts': { count: 2, how: 'keeps' }, // which rules are watched through their metric: an external one was refused before (alertStore.refuseExternal)
  'src/analysis/metrics.ts': { count: 2, how: 'keeps' }, // sanitize keeps it; an update keeps the stored one (D13)
  'src/analysis/pendingKinds.ts': { count: 7, how: 'keeps' }, // part 5's one classifier: an external one is none of its kinds
  'src/analysis/statusPin.ts': { count: 3, how: 'keeps' }, // the pin hashes the definition whole; an external one reads no column
  'src/analysis/columnHidden.ts': { count: 2, how: 'keeps' }, // a formula's names, then the definition walked whole for hidden columns
  'src/analysis/metricTimeScope.ts': { count: 8, how: 'keeps' }, // formulas, a period's base's date, a funnel's time: an external one counts by its own dataset
  'src/analysis/metricUsage.ts': { count: 3, how: 'keeps' }, // formula references and a period's base only
  'src/ipc/metricCheck.ts': { count: 2, how: 'keeps' }, // formula references only
  'src/ipc/funnelMetric.ts': { count: 1, how: 'keeps' }, // the funnel save check: an external one is no funnel
  'src/ipc/metricTree.ts': { count: 2, how: 'keeps' }, // the suggester's list: names and formulas
  'src/ipc/periods.ts': { count: 1, how: 'keeps' }, // formats a delta after resolveMetric (which refuses first)
  'web/src/features/calc/MeasureForm.tsx': { count: 1, how: 'keeps' }, // formulas only
  // words
  'src/analysis/metricFormat.ts': { count: 4, how: 'words' }, // + a period metric's words (p5-05)
  'src/automation/handlers.ts': { count: 2, how: 'words' }, // list_metrics' snapshot flag; metric_value refuses through resolveMetric
  'src/ipc/search.ts': { count: 5, how: 'words' },
  'src/ai/topicFacts.ts': { count: 1, how: 'words' }, // a period metric's words name its base (an external one: definedElsewhere)
  'src/publish/kpiSubtitle.ts': { count: 1, how: 'words' }, // no subtitle
  'web/src/features/visuals/EncodingForm.tsx': { count: 1, how: 'words' }, // the server's definitionText
};
