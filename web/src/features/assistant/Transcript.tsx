// The conversation — askCore.ts (bubbles, provenance, streaming) and
// askActivity.ts (the app showing its work), ported. Everything the model sent
// is rendered as TEXT: React escapes it, and nothing here sets HTML — a token
// can carry markup, exactly why the desktop was textContent-only.
//
// The stream is a PREVIEW. The pending bubble fills token by token; when the
// ask resolves, the transcript is the stored turns (disk truth) and the preview
// is gone. Activity chips are ephemeral: live under the pending bubble, then a
// quiet one-line summary above the answer, dropped by the next ask or reload.

import { useState, type ReactNode } from 'react';
import { buttonClass } from '../../ui/Button';
import { Icon } from '../../ui/icons/Icon';
import { OutsideCard } from './AgentPicker';
import { AnswerCard } from './AnswerCard';
import type { ActivityStep, Provenance, Turn } from './api';
import { DidYouMean, type Learn } from './DidYouMean';
import s from './Dock.module.css';

/** "kind: name · dataset: x · columns: a, b… · stats app-computed" — a footnote, not pills. */
export function provenanceLine(p: Provenance): string {
  const parts: string[] = [];
  if (p.kind && p.name) parts.push(`${p.kind}: ${p.name}`);
  else if (p.kind) parts.push(p.kind);
  if (p.datasetName) parts.push(`dataset: ${p.datasetName}`);
  if (Array.isArray(p.columns) && p.columns.length) {
    parts.push(`columns: ${p.columns.slice(0, 6).join(', ')}${p.columns.length > 6 ? '…' : ''}`);
  }
  parts.push(p.note || 'stats app-computed');
  return parts.join(' · ');
}

export interface Pending {
  askId: string;
  question: string;
  /** Streamed text so far; '' until the first token. */
  text: string;
  steps: ActivityStep[];
}

function Chips({ steps }: { steps: readonly ActivityStep[] }) {
  return (
    <div className={s.chips}>
      {steps.map((st, i) => (
        <span key={i} className={st.kind === 'model' ? `${s.chip} ${s.chipModel}` : s.chip}>
          {st.detail ? `${st.label} · ${st.detail}` : st.label}
        </span>
      ))}
    </div>
  );
}

/** The finished ask's work, collapsed to one line that expands to the chips. The model step is left out: the answer IS its output. */
function ActivitySummary({ steps }: { steps: readonly ActivityStep[] }) {
  const [open, setOpen] = useState(false);
  const text = steps.filter((x) => x.kind !== 'model').map((x) => x.label).join(' · ') || 'Prepared the answer';
  return (
    <div className={s.activity}>
      <button type="button" className={s.summary} aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
        <span className={s.summaryText}>{text}</span>
      </button>
      {open && <Chips steps={steps} />}
    </div>
  );
}

export function Transcript({
  turns,
  pending,
  lastSteps,
  projectId,
  threadId,
  onFollowUp,
  onNotThis,
  aside,
  agentName,
  onAskProject,
}: {
  turns: readonly Turn[];
  pending: Pending | null;
  /** The last finished ask's activity, shown collapsed above the answer it prepared. */
  lastSteps: { turnId: string; steps: readonly ActivityStep[] } | null;
  projectId: string;
  /** The conversation on screen ('' before it has one): a saved answer is recorded on its turn. */
  threadId: string;
  onFollowUp: (spec: Record<string, unknown>, label: string, learn?: Learn) => Promise<void>;
  /** "Not what I asked" under an answer from a verified question: ask the model the same question. None: no button. */
  onNotThis?: (question: string) => void;
  /** More under an answer, after its provenance line (the Data model's test chat: how it was found). `asked`: the turn before. */
  aside?: (t: Turn, asked?: Turn) => ReactNode;
  /** The Assistant agent this conversation is with, which an out-of-scope reply is signed by. */
  agentName?: string;
  /** An out-of-scope reply's one click: the question before it, to the Project assistant in a new conversation. */
  onAskProject?: (question: string) => void;
}) {
  return (
    <>
      {turns.map((t, i) => (
        <div key={t.id} className={`${s.msg} ${t.role === 'assistant' ? s.assistant : s.user} ${i === 0 ? s.stageTop : ''}`} data-role={t.role}>
          {lastSteps && t.id === lastSteps.turnId && !pending && <ActivitySummary steps={lastSteps.steps} />}
          {t.role === 'assistant' && t.answer && (
            <AnswerCard
              projectId={projectId}
              spec={t.answer}
              learn={t.learn}
              turn={threadId ? { threadId, turnId: t.id } : undefined}
              card={t.card}
              savedVisualId={t.savedVisualId}
              narrated={false}
              question={turns[i - 1]?.role === 'user' ? turns[i - 1].text.slice(0, 300) : undefined}
              onFollowUp={onFollowUp}
            />
          )}
          {t.role === 'assistant' && t.outside ? (
            <OutsideCard
              agent={agentName || 'This assistant'}
              text={t.text}
              busy={!!pending}
              onAsk={onAskProject && turns[i - 1]?.role === 'user' ? () => onAskProject(turns[i - 1].text) : undefined}
            />
          ) : (
            (t.role === 'user' || !t.answer || t.text.trim() !== '') && <div className={s.bubble}>{t.text}</div>
          )}
          {/* A refused chart is not a dead end: what the app thinks was meant, one click each. */}
          {t.role === 'assistant' && t.suggest && <DidYouMean options={t.suggest.options} said={t.suggest.said} onPick={onFollowUp} />}
          {t.role === 'assistant' && t.guidance?.verifiedId && onNotThis && turns[i - 1]?.role === 'user' && (
            <div className={s.matched} data-testid="verified-matched">
              <span>Same words as a verified question, so this is its chart.</span>
              <button type="button" className={buttonClass('ghost', 'sm')} disabled={!!pending} onClick={() => onNotThis(turns[i - 1].text)}>
                Not what I asked
              </button>
            </div>
          )}
          {t.role === 'assistant' && t.provenance && <div className={s.provenance}>{provenanceLine(t.provenance)}</div>}
          {aside && t.role === 'assistant' && aside(t, turns[i - 1])}
        </div>
      ))}
      {pending && (
        <>
          <div className={`${s.msg} ${s.user} ${turns.length === 0 ? s.stageTop : ''}`} data-role="user">
            <div className={s.bubble}>{pending.question}</div>
          </div>
          <div className={`${s.msg} ${s.assistant}`} data-role="assistant" aria-live="polite" aria-busy="true">
            <div className={pending.text ? `${s.bubble} ${s.streaming}` : `${s.bubble} ${s.thinking}`} data-testid="dock-pending">
              {pending.text || 'Thinking…'}
            </div>
            {pending.steps.length > 0 && (
              <div className={s.activity}>
                <Chips steps={pending.steps} />
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
