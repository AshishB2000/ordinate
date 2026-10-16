// The host backend's signing code, Node and Python (./snippets.ts), with Copy.
// Shown in Admin → Embedding (generic) and a link's Embed dialog (filled in).

import { useState } from 'react';
import { Button } from '../../ui/Button';
import { Tab, TabList, TabPanel, Tabs } from '../../ui/Tabs';
import { toast } from '../../ui/Toast';
import { nodeSnippet, pythonSnippet, type SnippetInput } from './snippets';
import s from './Embed.module.css';

export function copy(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied.`, { kind: 'success' }),
    () => toast('Copy failed — select the text and copy it instead.', { kind: 'error' }),
  );
}

export function EmbedSnippets({ input }: { input: SnippetInput }) {
  const [tab, setTab] = useState('node');
  const code = { node: nodeSnippet(input), python: pythonSnippet(input) };
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabList label="Signing code">
        <Tab value="node" icon="code">
          Node
        </Tab>
        <Tab value="python" icon="terminal">
          Python
        </Tab>
      </TabList>
      {(['node', 'python'] as const).map((k) => (
        <TabPanel key={k} value={k}>
          <div className={s.codeBox}>
            <div className={s.codeHead}>
              <span className={s.codeFile}>{k === 'node' ? 'embed-url.js' : 'embed_url.py'}</span>
              <Button size="sm" variant="ghost" icon="copy" onClick={() => copy(code[k], 'The code')} aria-label={`Copy the ${k === 'node' ? 'Node' : 'Python'} code`}>
                Copy
              </Button>
            </div>
            <pre className={s.code} data-testid={`snippet-${k}`}>
              {code[k]}
            </pre>
          </div>
        </TabPanel>
      ))}
    </Tabs>
  );
}
