// What an answer offers (docs/explore/00-design.md): Copy link for everyone —
// the URL IS the question — and, for an editor only, Open in the builder and
// Save as visual. A viewer is offered neither: hidden, never disabled (#307).
// `canEdit` is false until the roles arrive, so neither flashes for a viewer.

import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../ui/Button';
import { toast } from '../../ui/Toast';
import { saveVisual } from '../visuals/api';
import { liveFilters } from '../visuals/filters/filterText';
import { NameDialog } from '../visuals/NameDialog';
import type { Question } from './spec';
import s from './Explore.module.css';

async function copyLink(): Promise<void> {
  try {
    await navigator.clipboard.writeText(window.location.href);
    toast('Link copied — anyone with access to this project sees this question.', { kind: 'success' });
  } catch {
    toast('The clipboard is not available here.', { kind: 'error' });
  }
}

export function AnswerActions({ projectId, datasetId, canEdit, answered, question, chartType, grain, title }: {
  projectId: string;
  datasetId: string;
  canEdit: boolean;
  /** False while the question is refused or failed: a visual that cannot draw is not worth saving. */
  answered: boolean;
  question: Question;
  /** The chart on screen. */
  chartType: string;
  /** The grain the server chose for an "Auto" date axis — kept on save, as the builder's Save does. */
  grain?: string;
  title: string;
}) {
  const navigate = useNavigate();
  const client = useQueryClient();
  const [naming, setNaming] = useState(false);
  const e = question.encoding;
  const filters = liveFilters(question.filters);

  const save = async (name: string) => {
    const saved = await saveVisual({ projectId, datasetId, name, chartType, encoding: !e.grain && grain ? { ...e, grain } : e, overrides: {}, filters });
    void client.invalidateQueries({ queryKey: ['visual:list', projectId] });
    setNaming(false);
    toast(`Saved “${saved.name}” to Visuals.`, { kind: 'success', action: { label: 'Open', onClick: () => void navigate(`/visuals/${projectId}/${saved.id}`) } });
  };

  return (
    <div className={s.answerActions}>
      <Button size="sm" icon="link" onClick={() => void copyLink()}>
        Copy link
      </Button>
      {canEdit && (
        <>
          <Button
            size="sm"
            icon="external-link"
            // The builder, prefilled: for what Explore does not do — styling, analytics, pivots.
            onClick={() => void navigate(`/visuals/${projectId}/new?dataset=${encodeURIComponent(datasetId)}`, { state: { encoding: e, chartType, filters } })}
          >
            Open in the builder
          </Button>
          {answered && (
            <Button size="sm" variant="primary" icon="plus" onClick={() => setNaming(true)}>
              Save as visual
            </Button>
          )}
        </>
      )}
      {naming && <NameDialog name={title} title="Save as a visual" action="Save" onClose={() => setNaming(false)} onRename={save} />}
    </div>
  );
}
