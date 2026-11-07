// The inventory behind scripts/test-termSites.ts: every file under src/ and web/src that matches the
// test's PATTERNS (a `type === 'filter'` test, a `case 'filter':`, a filter-list sanitizer or merge, a
// predicate builder), with how many matches it has and what its sites do to a glossary `term` step.
// The test counts the matches in each file and fails on any difference, so a new site is classified
// here (keep the term, or refuse it) in the commit that adds it. Never raise a number to make the test pass.
//
// A file with sites of several kinds carries the strictest of them (keeps > door > throws > ignores > prepare).

export type TermSiteHow = 'keeps' | 'door' | 'throws' | 'prepare' | 'ignores';

export const TERM_SITES: Readonly<Record<string, { count: number; how: TermSiteHow }>> = {
  // keeps: sanitizes, merges or rewrites a filter list BEFORE a door. Must keep a term step (sanitizeFilterList / isKeptStep).
  'src/analysis/alertStore.ts': { count: 1, how: 'keeps' },
  'src/analysis/analysis.ts': { count: 3, how: 'keeps' },
  'src/analysis/analysisPlan.ts': { count: 1, how: 'keeps' },
  'src/analysis/cardModel.ts': { count: 2, how: 'keeps' },
  'src/analysis/dashboardDelta.ts': { count: 1, how: 'keeps' },
  'src/analysis/dashboardFilters.ts': { count: 2, how: 'keeps' },
  'src/analysis/dashboards.ts': { count: 3, how: 'keeps' },
  'src/analysis/driverShape.ts': { count: 1, how: 'keeps' },
  // a followed metric's stored filters, params bound (resolveFilterParams keeps a term). Every use asks the chart door
  // again (vizMetricMeasures `ask` = vizDataFor), whose lockedViz expands the list first or refuses it typed.
  'src/analysis/metricMeasures.ts': { count: 2, how: 'keeps' },
  'src/analysis/metrics.ts': { count: 4, how: 'keeps' },
  // resolveFilterParams keeps; paramRefs reads filter steps only (a Prepare-style pass-through)
  'src/analysis/params.ts': { count: 4, how: 'keeps' },
  'src/analysis/periodScope.ts': { count: 3, how: 'keeps' },
  'src/analysis/publishedCopy.ts': { count: 1, how: 'keeps' },
  'src/analysis/reportPages.ts': { count: 2, how: 'keeps' },
  'src/analysis/savedViews.ts': { count: 2, how: 'keeps' },
  'src/analysis/scenarioModel.ts': { count: 1, how: 'keeps' },
  'src/analysis/scenarioResolve.ts': { count: 1, how: 'keeps' },
  'src/analysis/storyModel.ts': { count: 5, how: 'keeps' },
  'src/analysis/visuals.ts': { count: 5, how: 'keeps' },
  'src/automation/creators.ts': { count: 2, how: 'keeps' },
  'src/data/filterList.ts': { count: 4, how: 'keeps' },
  // the one-step helper under sanitizeFilterList and sanitizeSteps
  'src/data/filterStepSanitize.ts': { count: 1, how: 'keeps' },
  // also three specFilterSteps calls after the door (throws): the steps, and the filter text with a value withheld or
  // said by its value label (computeCard expands terms first; a term left in throws typed); the strictest wins
  'src/ipc/answers.ts': { count: 4, how: 'keeps' },
  'src/ipc/copilotCards.ts': { count: 2, how: 'keeps' },
  // resolveFilterParams keeps a term; the Assistant's sentence names it by its kind (isKeptStep), no figure is computed
  'src/ipc/copilotMeasures.ts': { count: 1, how: 'keeps' },
  'src/ipc/dashboards.ts': { count: 2, how: 'keeps' },
  // also pageFor's lock merge (door) and sanitizeSteps (prepare); the strictest wins
  'src/ipc/datasets.ts': { count: 3, how: 'keeps' },
  'src/ipc/drillScope.ts': { count: 3, how: 'keeps' },
  'src/ipc/drivers.ts': { count: 3, how: 'keeps' },
  'src/ipc/driversPoint.ts': { count: 2, how: 'keeps' },
  'src/ipc/insights.ts': { count: 1, how: 'keeps' },
  'src/ipc/metricTree.ts': { count: 2, how: 'keeps' },
  'src/ipc/metrics.ts': { count: 7, how: 'keeps' },
  'src/ipc/periods.ts': { count: 2, how: 'keeps' },
  'src/ipc/scenarios.ts': { count: 2, how: 'keeps' },
  'src/ipc/stats.ts': { count: 2, how: 'keeps' },
  'src/ipc/subscriptionFigures.ts': { count: 1, how: 'keeps' },
  'src/ipc/summary.ts': { count: 2, how: 'keeps' },
  'src/ipc/versionDiff.ts': { count: 2, how: 'keeps' },
  'src/ipc/visuals.ts': { count: 2, how: 'keeps' },
  'src/ipc/vizSample.ts': { count: 2, how: 'keeps' },
  'src/publish/dashboardData.ts': { count: 6, how: 'keeps' },
  'src/publish/storyData.ts': { count: 1, how: 'keeps' },
  'web/src/features/analyses/VisualTile.tsx': { count: 3, how: 'keeps' },
  'web/src/features/analyses/editor/Editor.tsx': { count: 4, how: 'keeps' },
  'web/src/features/analyses/metrics/MetricEditor.tsx': { count: 1, how: 'keeps' },
  'web/src/features/dashboards/CardRuntime.tsx': { count: 3, how: 'keeps' },
  'web/src/features/dashboards/ControlsExtras.tsx': { count: 1, how: 'keeps' },
  'web/src/features/dashboards/tileActions.tsx': { count: 5, how: 'keeps' },
  'web/src/features/dashboards/useViewer.ts': { count: 1, how: 'keeps' },
  // the Live dataset's Always applied: saved through liveFilters, which keeps a term step (the server's contract refuses one)
  'web/src/features/data/BaseFiltersPanel.tsx': { count: 1, how: 'keeps' },
  'web/src/features/explore/Answer.tsx': { count: 1, how: 'keeps' },
  'web/src/features/explore/AnswerActions.tsx': { count: 1, how: 'keeps' },
  'web/src/features/explore/spec.ts': { count: 1, how: 'keeps' },
  'web/src/features/visuals/builderState.ts': { count: 1, how: 'keeps' },
  'web/src/features/visuals/filters/filterText.ts': { count: 1, how: 'keeps' },
  // door: the figure entry. Expands a term (expandTerms), or refuses it typed; the row lock keeps one.
  'src/analysis/termExpand.ts': { count: 2, how: 'door' },
  // withLockSteps keeps a term; only the door that expanded it may drop it
  'src/data/rowAccess.ts': { count: 2, how: 'door' },
  'src/ipc/rowDoors.ts': { count: 2, how: 'door' },
  // throws: an engine after the door. A term that reaches it throws TermNotExpandedError, never skipped.
  'src/ai/answerSpec.ts': { count: 1, how: 'throws' },
  'src/engine/cohortResident.ts': { count: 1, how: 'throws' },
  'src/engine/datasetPage.ts': { count: 2, how: 'throws' },
  'src/engine/driversResident.ts': { count: 1, how: 'throws' },
  'src/engine/facetResident.ts': { count: 1, how: 'throws' },
  'src/engine/funnelResident.ts': { count: 1, how: 'throws' },
  'src/engine/fxResident.ts': { count: 2, how: 'throws' },
  'src/engine/geoResident.ts': { count: 1, how: 'throws' },
  'src/engine/joinResident.ts': { count: 3, how: 'throws' },
  // liveBaseOf: a base filter through adaptFilter, which throws on a term (a base list is sanitized to plain filters first)
  'src/engine/live/liveBase.ts': { count: 1, how: 'throws' },
  'src/engine/live/liveQuery.ts': { count: 1, how: 'throws' },
  'src/engine/live/liveSpec.ts': { count: 8, how: 'throws' },
  'src/engine/lodResident.ts': { count: 1, how: 'throws' },
  'src/engine/pivotResident.ts': { count: 3, how: 'throws' },
  'src/engine/residentFilter.ts': { count: 4, how: 'throws' },
  'src/engine/residentQuery.ts': { count: 1, how: 'throws' },
  'src/engine/scenarioResident.ts': { count: 2, how: 'throws' },
  'src/engine/statsVectors.ts': { count: 1, how: 'throws' },
  // the Prepare fold's dispatch: foldStep rethrows TermNotExpandedError, an unknown step type still skips
  'src/data/transforms.ts': { count: 1, how: 'throws' },
  // adaptFilter and specFilterSteps callers: a term refuses, never skips
  'src/ipc/liveAnswers.ts': { count: 3, how: 'throws' },
  'src/ipc/visualsResident.ts': { count: 1, how: 'throws' },
  // prepare: a Prepare list (or a dataset setting). Must NOT take a term; unchanged, an unknown step is dropped.
  'src/ai/planCheck.ts': { count: 1, how: 'prepare' },
  'src/data/datasets.ts': { count: 3, how: 'prepare' },
  'src/data/inputTable/store.ts': { count: 1, how: 'prepare' },
  // a cascading picker's parent picks: plain filter steps only, a term is dropped on purpose (narrows less, never more)
  'src/ipc/distinctNarrow.ts': { count: 2, how: 'prepare' },
  // a Live dataset's base filters are a dataset setting: a term is dropped on purpose, like Prepare
  'src/data/liveBaseFilters.ts': { count: 2, how: 'prepare' },
  // a term's own filters are plain steps: a term inside a term is refused on save (termProblem), dropped on read
  'src/analysis/terms.ts': { count: 2, how: 'prepare' },
  'src/data/rowPolicy.ts': { count: 1, how: 'prepare' },
  'src/data/stepSanitize.ts': { count: 3, how: 'prepare' },
  'src/engine/sqlGen.ts': { count: 2, how: 'prepare' },
  'src/ipc/modelOverview.ts': { count: 1, how: 'prepare' }, // reads a copy's Prepare filter steps to show them; a Prepare list takes no term
  'src/ipc/rowPolicy.ts': { count: 1, how: 'prepare' },
  'src/ipc/segments.ts': { count: 1, how: 'prepare' },
  // a term's own filter rows (no term inside a term: FilterRows terms={false}); the server refuses one anyway. Also
  // the certified-change warning (p4-03), which compares the same rows as the save sends them
  'web/src/features/model/terms/TermDialog.tsx': { count: 2, how: 'prepare' },
  'web/src/features/prepare/drafts.ts': { count: 3, how: 'prepare' },
  'web/src/features/prepare/steps.ts': { count: 1, how: 'prepare' },
  // ignores: reads the shape only (a label, a diff). No crash on a term; skips it.
  'src/analysis/versionDiffParts.ts': { count: 1, how: 'ignores' },
  // a status pin (part 4) reads a plain filter's column; a term step is a dep, hashed by its own pin
  'src/analysis/statusPin.ts': { count: 1, how: 'ignores' },
  // names a term by its name and any other kept step by its kind, in a version's facts (05b)
  'web/src/features/projects/VersionPreview.tsx': { count: 2, how: 'ignores' },
};
