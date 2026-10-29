// The Dashboards page header's ways to start one (editors): Draft with AI, and Create dashboard — the new-dashboard
// wizard — as a split button whose arrow holds the other ways in: a blank dashboard (the same wizard) and a dashboard
// rebuilt from a screenshot (its own page). Rebuild is rarely used, so it is not a header button of its own.

import { useNavigate } from 'react-router';
import { Button } from '../../../ui/Button';
import { Menu } from '../../../ui/Menu';
import { Icon } from '../../../ui/icons/Icon';
import s from './List.module.css';

export function CreateActions({ projectId, aiReady, aiWhy, onCreate, onDraft }: {
  projectId: string;
  aiReady: boolean;
  aiWhy: string;
  onCreate: () => void;
  onDraft: () => void;
}) {
  const navigate = useNavigate();
  return (
    <>
      <Button className={s.draft} icon="sparkles" onClick={onDraft} disabled={!aiReady} title={aiReady ? undefined : aiWhy}>
        Draft with AI
      </Button>
      <span className={s.split}>
        <Button variant="primary" icon="plus" onClick={onCreate}>
          Create dashboard
        </Button>
        <Menu
          label="More ways to create"
          align="end"
          trigger={
            <button type="button" className={s.splitArrow} aria-label="More ways to create" title="More ways to create">
              <Icon name="chevron-down" />
            </button>
          }
          items={[
            { label: 'Blank dashboard', icon: 'plus', onSelect: onCreate },
            { label: 'Rebuild from a screenshot', icon: 'camera', onSelect: () => void navigate(`/analyses/${projectId}/rebuild`) },
          ]}
        />
      </span>
    </>
  );
}
