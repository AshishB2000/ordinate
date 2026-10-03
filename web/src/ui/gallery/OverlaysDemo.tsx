// Gallery: overlays (menus, popover, tooltip, dialog, drawer), navigation
// (tabs, toolbar) and feedback (toasts, badges, keys). With ?open=1 the
// non-modal overlays mount OPEN so one screenshot shows them; ?open=dialog
// and ?open=drawer open those (they cover the page, so they get their own).

import { useEffect, useState } from 'react';
import { Badge } from '../Badge';
import { Button, IconButton } from '../Button';
import { Dialog, DialogClose, Drawer } from '../Dialog';
import { Input } from '../Field';
import { Kbd } from '../Kbd';
import { ContextMenu, Menu, type MenuEntry } from '../Menu';
import { Popover, PopoverClose } from '../Popover';
import { Select } from '../Select';
import { Tab, TabList, TabPanel, Tabs } from '../Tabs';
import { toast } from '../Toast';
import { Toolbar, ToolbarDivider, ToolbarSpacer } from '../Toolbar';
import { Tooltip } from '../Tooltip';
import { Cell, Grid, Section } from './Demo';
import g from './Gallery.module.css';

const noop = () => {};
const CARD_MENU: MenuEntry[] = [
  { label: 'Open', icon: 'external-link', shortcut: '↵', onSelect: noop },
  { label: 'Rename', icon: 'pencil', shortcut: 'F2', onSelect: noop },
  { label: 'Duplicate', icon: 'copy', shortcut: '⌘D', onSelect: noop },
  { label: 'Export', icon: 'download', disabled: true, onSelect: noop },
  { kind: 'separator' },
  { kind: 'heading', label: 'Sort by' },
  {
    kind: 'radio',
    label: 'Sort by',
    value: 'name',
    options: [
      { value: 'name', label: 'Name' },
      { value: 'updated', label: 'Last updated' },
    ],
    onChange: noop,
  },
  { kind: 'separator' },
  { label: 'Move to trash', icon: 'trash', danger: true, onSelect: noop },
];

export function OverlaysDemo({ open }: { open: string | null }) {
  const forced = open === '1';
  const [dialog, setDialog] = useState(open === 'dialog');
  const [drawer, setDrawer] = useState(open === 'drawer');
  const [name, setName] = useState('Q3 revenue');
  return (
    <Section id="overlays" title="Menu · ContextMenu · Popover · Tooltip · Dialog · Drawer" note="Focus moves in on open and back to the trigger on close; Escape dismisses.">
      <div className={forced ? g.overlayHost : undefined}>
        <Grid>
          <Cell label={forced ? 'Menu (open): icons, shortcut, disabled, radio, danger' : 'Menu'}>
            <Menu
              trigger={<IconButton icon="more-horizontal" label="Card actions" />}
              items={CARD_MENU}
              open={forced || undefined}
              onOpenChange={forced ? noop : undefined}
            />
          </Cell>
          <Cell label={forced ? 'Popover (open)' : 'Popover'}>
            <Popover
              title="Rename"
              heading
              trigger={<Button iconEnd="chevron-down">Rename</Button>}
              open={forced || undefined}
              onOpenChange={forced ? noop : undefined}
            >
              <Input aria-label="New name" value={name} onChange={(e) => setName(e.target.value)} />
              <div className={g.row}>
                <PopoverClose asChild>
                  <Button variant="ghost" size="sm">
                    Cancel
                  </Button>
                </PopoverClose>
                <PopoverClose asChild>
                  <Button variant="primary" size="sm">
                    Save
                  </Button>
                </PopoverClose>
              </div>
            </Popover>
          </Cell>
          <Cell label={forced ? 'Tooltip (open) · on hover and focus, 300ms' : 'Tooltip: hover or focus'}>
            <Tooltip content="Refresh from the source" side="right" open={forced || undefined}>
              <IconButton icon="refresh" label="Refresh" />
            </Tooltip>
          </Cell>
        </Grid>
      </div>
      <Grid>
        <Cell label="ContextMenu: right-click (or Shift+F10) the card">
          <ContextMenu items={CARD_MENU} label="Card actions">
            <div className={g.ctxTarget} tabIndex={0}>
              Sales by region
            </div>
          </ContextMenu>
        </Cell>
        <Cell label="Dialog (modal, focus trapped)">
          <Dialog
            open={dialog}
            onOpenChange={setDialog}
            trigger={<Button>Open dialog</Button>}
            title="Delete “Q3 revenue”?"
            description="The dashboard and its 6 cards move to the trash. You can restore it for 30 days."
            size="sm"
            footer={
              <>
                <DialogClose asChild>
                  <Button variant="ghost">Cancel</Button>
                </DialogClose>
                <Button variant="danger" icon="trash" onClick={() => setDialog(false)}>
                  Delete
                </Button>
              </>
            }
          />
        </Cell>
        <Cell label="Drawer (modal sheet, right edge)">
          <Drawer
            open={drawer}
            onOpenChange={setDrawer}
            trigger={<Button icon="history">Version history</Button>}
            title="Version history"
            description="Dashboard · 14 versions"
            footer={<Button variant="primary">Restore this version</Button>}
          >
            <Input label="Find a version" icon="search" placeholder="Search" />
            <Select aria-label="Author" value="all" onValueChange={noop} options={[{ value: 'all', label: 'Everyone' }]} />
            <p className={g.prose}>Each save is a version. Open one to preview it; restore makes it the live version.</p>
          </Drawer>
        </Cell>
      </Grid>
    </Section>
  );
}

export function NavigationDemo() {
  const [tab, setTab] = useState('rows');
  return (
    <Section id="nav" title="Tabs · Toolbar" note="Tabs: ←/→ Home/End. Toolbar: ←/→ between its controls.">
      <Grid>
        <Cell label="Tabs: icon, count, disabled" wide>
          <Tabs value={tab} onValueChange={setTab}>
            <TabList label="Dataset">
              <Tab value="rows" icon="table" count="12,408">
                Rows
              </Tab>
              <Tab value="profile" icon="chart-bar">
                Profile
              </Tab>
              <Tab value="lineage" icon="lineage">
                Lineage
              </Tab>
              <Tab value="rules" disabled>
                Rules
              </Tab>
            </TabList>
            <TabPanel value="rows">
              <p className={g.prose}>The rows tab panel.</p>
            </TabPanel>
            <TabPanel value="profile">
              <p className={g.prose}>The profile tab panel.</p>
            </TabPanel>
            <TabPanel value="lineage">
              <p className={g.prose}>The lineage tab panel.</p>
            </TabPanel>
          </Tabs>
        </Cell>
        <Cell label="Toolbar: groups, divider, spacer" wide>
          <Toolbar label="Dataset actions">
            <Button variant="primary" icon="plus" size="sm">
              Add step
            </Button>
            <Button icon="filter" size="sm">
              Filter
            </Button>
            <ToolbarDivider />
            <IconButton icon="undo" label="Undo" size="sm" />
            <IconButton icon="redo" label="Redo" size="sm" disabled />
            <ToolbarSpacer />
            <IconButton icon="download" label="Export" size="sm" />
            <IconButton icon="more-horizontal" label="More" size="sm" />
          </Toolbar>
        </Cell>
      </Grid>
    </Section>
  );
}

export function FeedbackDemo({ seed }: { seed: boolean }) {
  // Screenshot mode puts one of each toast on screen (they live 4 s).
  useEffect(() => {
    if (!seed) return;
    toast('Saved “Q3 revenue”', { kind: 'success' });
    toast('Export failed: the file is open elsewhere', { kind: 'error', action: { label: 'Retry', onClick: noop } });
    toast('Refreshing 3 datasets…');
  }, [seed]);
  return (
    <Section id="feedback" title="Toast · Badge · Kbd" note="Toasts stack bottom-right, three at most, 4 s each; the stack is a polite live region.">
      <Grid>
        <Cell label="Toast: info / success / error with action">
          <Button size="sm" onClick={() => toast('Copied the link')}>
            Info
          </Button>
          <Button size="sm" onClick={() => toast('Saved', { kind: 'success' })}>
            Success
          </Button>
          <Button
            size="sm"
            onClick={() => toast('Could not reach the server', { kind: 'error', action: { label: 'Retry', onClick: noop } })}
          >
            Error + action
          </Button>
        </Cell>
        <Cell label="Badge: neutral / accent / ok / warn / error">
          <Badge>Archived</Badge>
          <Badge tone="accent">Draft</Badge>
          <Badge tone="ok" icon="check">
            Fresh
          </Badge>
          <Badge tone="warn">Stale</Badge>
          <Badge tone="error" icon="alert">
            Failed
          </Badge>
        </Cell>
        <Cell label="Kbd">
          <span className={g.prose}>
            Command palette <Kbd>⌘</Kbd>
            <Kbd>K</Kbd> · Shortcuts <Kbd>?</Kbd>
          </span>
        </Cell>
      </Grid>
    </Section>
  );
}
