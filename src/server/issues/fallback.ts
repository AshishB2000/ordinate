// An issue's own title and suggested fix, made by the app from its cause, for the board until a model names it (and when it cannot). No model
// words, no figure: the names are the ones people typed, shown as they were, and a cause with a digit in its name never got here (a label with
// a digit is not kept, src/ai/issueSignals.ts).

import { topWords } from '../../ai/issueGroups';
import type { ToName } from './db';
import * as say from '../issueMessages';

export function fallbackFor(i: Pick<ToName, 'key' | 'kind' | 'labels' | 'questions'>): { title: string; fix: string } {
  const label = i.labels[0] ?? '';
  if (i.key.startsWith('name:') && label) return { title: say.titleName(label), fix: say.fixName(label) };
  if (i.key.startsWith('miss:') && label) return { title: say.titleMiss(label), fix: say.fixMiss(label) };
  if (i.key.startsWith('link:') && label) return { title: say.titleLink(label), fix: say.fixLink() };
  if (i.key.startsWith('copy:')) return { title: say.titleCopy(), fix: say.fixCopy() };
  if (i.key.startsWith('outside:') && label) return { title: say.titleOutside(label), fix: say.fixOutside(label) };
  const words = topWords(i.questions.map((q) => ({ question: q }) as never)).join(', ');
  if (i.kind === 'untraced') return { title: say.titleUntraced(), fix: say.fixUntraced() };
  if (i.kind === 'asked_again') return { title: words ? say.titleWords(words) : say.titleAgain(), fix: say.fixAgain() };
  if (i.kind === 'thumbs_down') return { title: words ? say.titleWords(words) : say.titleThumbs(), fix: say.fixThumbs() };
  return { title: words ? say.titleWords(words) : say.titleThumbs(), fix: say.fixThumbs() };
}
