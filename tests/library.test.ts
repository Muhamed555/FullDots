import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  ageGroup,
  libraryItems,
  makerOf,
  pageExcerpt,
  SpaceLibrary,
} from '../src/client/SpaceLibrary';
import type { Page } from '../src/server/pages';
import type { SpaceFile } from '../src/shared/space-files';
import type { Dot, Space } from '../src/shared/types';

it('shows readable library previews without changing source content', () => {
  const source =
    '---\ntitle: Metadata\n---\n\n# Checklist\n- [ ] First task\n- [x] **Done**\n\n<details><summary>Context</summary>Notes</details>';
  expect(pageExcerpt(source)).toBe('Checklist First task Done Context Notes');
  expect(source).toContain('<details>');
  expect(source).toContain('- [ ]');
});

const NOW = new Date(2026, 10, 11, 15, 0).getTime();
const HOUR = 3_600_000;

const page = (id: string, title: string, extra: Partial<Page> = {}): Page => ({
  id,
  spaceId: 's1',
  parentId: null,
  title,
  content: `# ${title}\nSome notes.`,
  revision: 1,
  createdAt: NOW - 30 * 24 * HOUR,
  updatedAt: NOW - 30 * 24 * HOUR,
  sourceThreadId: null,
  ...extra,
});
const file = (
  id: string,
  name: string,
  kind: SpaceFile['kind'],
  extra: Partial<SpaceFile> = {},
): SpaceFile => ({
  id,
  spaceId: 's1',
  parentId: null,
  name,
  mediaType: 'application/octet-stream',
  kind,
  size: 2048,
  sha256: id,
  sourceThreadId: null,
  createdAt: NOW - HOUR,
  updatedAt: NOW - HOUR,
  ...extra,
});
const dots = [
  { id: 'd1', name: 'Scout' },
  { id: 'd2', name: 'Quill' },
] as unknown as Dot[];
const conversations = [
  { id: 't1', dotId: 'd1' },
  { id: 't2', dotId: 'd2' },
];
const space = { id: 's1', name: 'Launch', description: '' } as Space;

describe('Space library shelf', () => {
  it('puts pages and files on one shelf, each with its kind and badge', () => {
    const items = libraryItems(
      [page('p1', 'Plan')],
      [
        file('f1', 'chart.PNG', 'image'),
        file('f2', 'report.pdf', 'pdf'),
        file('f3', 'leads.csv', 'csv'),
        file('f4', 'notes.md', 'markdown'),
        file('f5', 'archive.zip', 'download'),
        file('f6', 'LICENSE', 'download'),
      ],
    );
    expect(items.map((item) => `${item.badge}:${item.category}`)).toEqual([
      'PAGE:page',
      'PNG:image',
      'PDF:document',
      'CSV:data',
      'MD:document',
      'ZIP:other',
      'FILE:other',
    ]);
    // A page and a file may share an id; their keys never clash.
    expect(new Set(items.map((item) => item.key)).size).toBe(items.length);
  });

  it('knows which Dot made an item from the chat that produced it', () => {
    expect(makerOf({ sourceThreadId: 't2' }, conversations, dots)?.name).toBe(
      'Quill',
    );
    // The owner's own work, and work from a chat or Dot that is gone, have no maker.
    expect(
      makerOf({ sourceThreadId: null }, conversations, dots),
    ).toBeUndefined();
    expect(
      makerOf({ sourceThreadId: 'gone' }, conversations, dots),
    ).toBeUndefined();
    expect(
      makerOf({ sourceThreadId: 't1' }, conversations, [dots[1]]),
    ).toBeUndefined();
  });

  it('sorts items onto shelves by age', () => {
    expect(ageGroup(NOW - HOUR, NOW)).toBe('Today');
    expect(ageGroup(NOW - 20 * HOUR, NOW)).toBe('This week');
    expect(ageGroup(NOW - 5 * 24 * HOUR, NOW)).toBe('This week');
    expect(ageGroup(NOW - 9 * 24 * HOUR, NOW)).toBe('Earlier');
  });

  const render = (pages: Page[], files: SpaceFile[]) =>
    renderToStaticMarkup(
      createElement(SpaceLibrary, {
        space,
        pages,
        files,
        dots,
        conversations,
        onPage: () => {},
        onFile: () => {},
        onUpload: () => {},
        onNew: () => {},
        now: NOW,
      }),
    );

  it('shows tabs with counts, only for kinds that are there', () => {
    const html = render(
      [page('p1', 'Plan'), page('p2', 'Brief')],
      [file('f1', 'chart.png', 'image'), file('f3', 'leads.csv', 'csv')],
    );
    expect(html).toMatch(/All <span>4<\/span>/);
    expect(html).toMatch(/Pages <span>2<\/span>/);
    expect(html).toMatch(/Images <span>1<\/span>/);
    expect(html).toMatch(/Data <span>1<\/span>/);
    expect(html).not.toContain('Documents <span>');
    expect(html).not.toContain('Other <span>');
  });

  it('names who made each item and offers them as a filter', () => {
    const html = render(
      [page('p1', 'Plan', { sourceThreadId: 't1' })],
      [
        file('f1', 'chart.png', 'image', { sourceThreadId: 't1' }),
        file('f2', 'mine.pdf', 'pdf'),
      ],
    );
    expect(html).toContain('title="Made by Scout"');
    expect(html).toContain('title="Added by you"');
    const makers = html.slice(html.indexOf('aria-label="Made by"'));
    expect(makers).toMatch(/Scout <span>2<\/span>/);
    expect(makers).toMatch(/You <span>1<\/span>/);
    expect(makers).not.toContain('Quill');
  });

  it('leaves the maker filter out when the owner made everything', () => {
    const html = render([page('p1', 'Plan')], [file('f2', 'mine.pdf', 'pdf')]);
    expect(html).not.toContain('aria-label="Made by"');
    expect(html).toContain('aria-label="Kind"');
  });

  it('splits the shelf by age, newest first', () => {
    const html = render(
      [page('p1', 'Old plan')],
      [file('f1', 'fresh.png', 'image')],
    );
    expect(html.indexOf('>Today<')).toBeGreaterThan(-1);
    expect(html.indexOf('>Earlier<')).toBeGreaterThan(html.indexOf('>Today<'));
    expect(html).not.toContain('>This week<');
  });

  it('invites a first page or file when the Space is empty', () => {
    const html = render([], []);
    expect(html).toContain('Nothing here yet');
    expect(html).toContain('ask a Dot to save its work');
    expect(html).not.toContain('aria-label="Kind"');
  });
});
