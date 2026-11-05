// The inventory behind scripts/test-countSites.ts (semantic layer part 5, step 02): every file under src/ and web/src
// that compares an aggregation with `count` (`=== 'count'`, `!== 'count'`, `case 'count':`), with how many such sites
// it has and what they mean now that `countd` exists. The test counts the matches in each file and fails on any
// difference, so a new site is classified here in the commit that adds it. Never raise a number to make the test pass.
//
//   countOnly  means `count` alone: a compute branch beside countd's own, or a surface that never takes countd
//   name       a series or field label
//
// A site that means "counts cells, any column type, never money" is not here: it is `isCountLike` (src/data/aggregations.ts).

export type CountSiteHow = 'countOnly' | 'name';

// A file with sites of both kinds is countOnly.
export const COUNT_SITES: Readonly<Record<string, { count: number; how: CountSiteHow }>> = {
  // compute branches: countd has its own branch beside each (analysis/countDistinct, engine/countDistinctSql)
  'src/analysis/metricValue.ts': { count: 1, how: 'countOnly' },
  'src/data/transforms.ts': { count: 1, how: 'countOnly' },
  'src/engine/residentQuery.ts': { count: 2, how: 'countOnly' }, // aggExpr's branch, and the series name
  // the definition itself
  'src/data/aggregations.ts': { count: 1, how: 'countOnly' },
  // scenario pieces fold sum/n/nonEmpty/min/max: a countd operand never folds (scenarioResolve isCountLike: no moves)
  'src/analysis/scenarioModel.ts': { count: 1, how: 'countOnly' },
  // additive checks: a distinct count does not add up (D3), so only sum and count pass
  'src/ipc/answers.ts': { count: 1, how: 'countOnly' },
  'src/ipc/liveAnswers.ts': { count: 1, how: 'countOnly' },
  // Live: compute branches; countd has its own part `d` beside each (engine/live/compileDistinct)
  'src/engine/live/compile.ts': { count: 3, how: 'countOnly' },
  'src/engine/live/shape.ts': { count: 2, how: 'countOnly' }, // the fold, and the series name
  // Prepare: the SQL group step bails countd to the fold; the pivot step never takes it (stepsSanitize)
  'src/engine/sqlGen.ts': { count: 1, how: 'countOnly' },
  'src/engine/sqlGenReshape.ts': { count: 1, how: 'countOnly' },
  'src/data/stepsReshape.ts': { count: 1, how: 'countOnly' },
  // LOD: its own COUNTD, which counts date spellings (D1 non-goal)
  'src/formula/lod.ts': { count: 1, how: 'countOnly' },
  // key drivers: refuse countd ("does not split into members")
  'src/analysis/driverShape.ts': { count: 3, how: 'countOnly' },
  'src/analysis/driversJs.ts': { count: 1, how: 'countOnly' },
  'src/engine/driversResident.ts': { count: 1, how: 'countOnly' },
  'src/publish/publishMessages.ts': { count: 1, how: 'countOnly' },
  // maps: GEO_AGGS is count, sum, avg; no map picker offers countd
  'src/analysis/geo/geoAgg.ts': { count: 2, how: 'countOnly' },
  'src/engine/geoResident.ts': { count: 1, how: 'countOnly' },
  'src/analysis/mapData.ts': { count: 1, how: 'countOnly' },
  'src/app/sharePolicy.ts': { count: 1, how: 'countOnly' },
  // rebuild: its aggregations are PLAIN_AGGREGATIONS
  'src/analysis/rebuildMatch.ts': { count: 2, how: 'countOnly' },
  'web/src/features/analyses/rebuild/RebuildTile.tsx': { count: 1, how: 'countOnly' },
  // the scenario metric's kind, which scenarios.ts already sets with isCountLike
  'web/src/features/analytics/scenarios/ScenarioParts.tsx': { count: 1, how: 'countOnly' },

  // names: a count's series is its column; any other is "<agg> of <column>" (a countd series is "count distinct of <column>")
  'src/ai/answerSpec.ts': { count: 1, how: 'name' },
  'src/analysis/chartFormat.ts': { count: 1, how: 'name' },
  'src/analysis/pivotData.ts': { count: 1, how: 'name' },
  'src/analysis/vizData.ts': { count: 1, how: 'name' },
  'src/engine/facetResident.ts': { count: 1, how: 'name' },
  'src/engine/joinResident.ts': { count: 1, how: 'name' },
  'web/src/features/visuals/builderState.ts': { count: 1, how: 'name' },
  // the formula editor's token colour (countd is a function name there too)
  'web/src/features/prepare/formulaParts.ts': { count: 1, how: 'name' },
};
