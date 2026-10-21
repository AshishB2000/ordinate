// With an AI model ready (docs/explore/00-design.md): plain words go to the
// existing ask flow — the Assistant dock, as Home's ask bar hands them over
// (openDockWith), asked in Explore's project. The model only narrates figures
// the app computed. Without a model this renders NOTHING: no dead box, and the
// page is complete without it.

import { useState } from 'react';
import { Icon } from '../../ui/icons/Icon';
import { useAiStatus } from '../assistant/api';
import { openDockWith, pickDockProject } from '../assistant/dockState';
import s from './Explore.module.css';

export function AskBox({ projectId }: { projectId: string }) {
  const ai = useAiStatus();
  const [q, setQ] = useState('');
  if (!ai.data?.ready) return null;
  return (
    <form
      className={s.ask}
      aria-label="Ask the Assistant"
      onSubmit={(ev) => {
        ev.preventDefault();
        const text = q.trim();
        if (!text) return;
        setQ('');
        pickDockProject(projectId);
        openDockWith(text);
      }}
    >
      <Icon name="sparkles" size={16} />
      <input
        className={s.askInput}
        type="text"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Or ask in your own words — the Assistant answers with the app’s figures"
        aria-label="Ask in your own words"
        autoComplete="off"
        maxLength={2000}
      />
      <button className={s.askSend} type="submit" aria-label="Ask" disabled={!q.trim()}>
        <Icon name="arrow-up" size={16} />
      </button>
    </form>
  );
}
