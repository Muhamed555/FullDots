// A Space's library: its pages and files on one shelf.
//
// Everything in a Space is shown together and found the same way: by what it is (the tabs), by
// who made it (you, or one of your Dots), or by name. Pictures are shown as pictures. Each item
// carries the Dot that made it, because in FullDots that is usually the question: "which of them
// wrote this?"
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  FileText,
  Plus,
  Search,
  LayoutGrid,
  List,
  Upload,
  UserRound,
} from 'lucide-react';
import type { FileKind, SpaceFile } from '../shared/space-files';
import { extensionOf, formatBytes } from '../shared/space-files';
import { FileKindIcon } from './file-icons';
import { Mascot, dotLook } from './Mascot';
import { fetchSpaceFile } from './space-files-api';
import type { Page } from '../server/pages';
import type { ConversationSummary, Dot, Space } from '../shared/types';
import './space-library.css';

export function pageExcerpt(content: string) {
  return content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/gm, '')
    .replace(/```[\s\S]*?```/g, 'Code block')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`|~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/** What an item is, as the tabs name it. */
export type LibraryCategory = 'page' | 'image' | 'document' | 'data' | 'other';

export const LIBRARY_TABS: readonly {
  id: 'all' | LibraryCategory;
  label: string;
}[] = [
  { id: 'all', label: 'All' },
  { id: 'page', label: 'Pages' },
  { id: 'image', label: 'Images' },
  { id: 'document', label: 'Documents' },
  { id: 'data', label: 'Data' },
  { id: 'other', label: 'Other' },
];

const FILE_CATEGORY: Record<FileKind, LibraryCategory> = {
  image: 'image',
  pdf: 'document',
  markdown: 'document',
  text: 'document',
  html: 'document',
  csv: 'data',
  json: 'data',
  download: 'other',
};

/** One thing on the shelf: a page, or a file. */
export interface LibraryItem {
  key: string;
  id: string;
  type: 'page' | 'file';
  title: string;
  category: LibraryCategory;
  /** The short label on the item's tile: PAGE, PDF, CSV, PNG. */
  badge: string;
  updatedAt: number;
  /** The chat that produced it, when a Dot did. */
  sourceThreadId: string | null;
  page?: Page;
  file?: SpaceFile;
}

export function libraryItems(pages: Page[], files: SpaceFile[]): LibraryItem[] {
  return [
    ...pages.map((page): LibraryItem => ({
      key: `page:${page.id}`,
      id: page.id,
      type: 'page',
      title: page.title,
      category: 'page',
      badge: 'PAGE',
      updatedAt: page.updatedAt,
      sourceThreadId: page.sourceThreadId,
      page,
    })),
    ...files.map((file): LibraryItem => ({
      key: `file:${file.id}`,
      id: file.id,
      type: 'file',
      title: file.name,
      category: FILE_CATEGORY[file.kind],
      badge: (extensionOf(file.name) || 'file').slice(0, 4).toUpperCase(),
      updatedAt: file.updatedAt,
      sourceThreadId: file.sourceThreadId,
      file,
    })),
  ];
}

/** The Dot whose chat produced an item; nothing for what the owner wrote or uploaded. */
export function makerOf(
  item: Pick<LibraryItem, 'sourceThreadId'>,
  conversations: Pick<ConversationSummary, 'id' | 'dotId'>[],
  dots: Dot[],
): Dot | undefined {
  if (!item.sourceThreadId) return undefined;
  const dotId = conversations.find(
    (thread) => thread.id === item.sourceThreadId,
  )?.dotId;
  return dots.find((dot) => dot.id === dotId);
}

export const AGE_GROUPS = ['Today', 'This week', 'Earlier'] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** Which shelf an item sits on when the library is in order of time. */
export function ageGroup(updatedAt: number, now: number): AgeGroup {
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (updatedAt >= startOfToday.getTime()) return 'Today';
  return updatedAt >= startOfToday.getTime() - 6 * 86_400_000
    ? 'This week'
    : 'Earlier';
}

const MAKER_ALL = 'all';
const MAKER_YOU = 'you';

/** A picture file, fetched only once its card is near the screen. */
function Thumbnail({ file }: { file: SpaceFile }) {
  const holder = useRef<HTMLSpanElement>(null);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const controller = new AbortController();
    let created: string | undefined;
    const load = () =>
      void fetchSpaceFile(file.spaceId, file.id, controller.signal)
        .then((blob) => {
          created = URL.createObjectURL(blob);
          setUrl(created);
        })
        // The card keeps its icon when the picture cannot be read.
        .catch(() => {});
    if (typeof IntersectionObserver !== 'function') {
      load();
      return () => controller.abort();
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        load();
      },
      { rootMargin: '200px' },
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
    // The picture changes only when the file's contents do.
  }, [file.spaceId, file.id, file.sha256]);
  return (
    <span className="lib-thumb" ref={holder}>
      {url ? (
        <img src={url} alt="" loading="lazy" />
      ) : (
        <FileKindIcon kind="image" size={26} strokeWidth={1.4} />
      )}
    </span>
  );
}

function MakerMark({ dot }: { dot?: Dot }) {
  return dot ? (
    <span className="lib-maker" title={`Made by ${dot.name}`}>
      <Mascot
        identity={dot.id}
        {...dotLook(dot)}
        name={dot.name}
        small
        decorative
      />
      <span>{dot.name}</span>
    </span>
  ) : (
    <span className="lib-maker you" title="Added by you">
      <UserRound size={13} aria-hidden />
      <span>You</span>
    </span>
  );
}

const shortDate = (time: number) =>
  new Date(time).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });

export function SpaceLibrary({
  space,
  pages,
  files,
  dots = [],
  conversations = [],
  onPage,
  onFile,
  onUpload,
  onNew,
  now = Date.now(),
}: {
  space: Space;
  pages: Page[];
  files: SpaceFile[];
  /** With the chats, these say which Dot made each item. */
  dots?: Dot[];
  conversations?: Pick<ConversationSummary, 'id' | 'dotId'>[];
  onPage: (id: string) => void;
  onFile: (id: string) => void;
  onUpload: (files: File[]) => void;
  onNew: () => void;
  now?: number;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<'grid' | 'list'>('grid');
  const [sort, setSort] = useState('recent');
  const [tab, setTab] = useState<'all' | LibraryCategory>('all');
  const [maker, setMaker] = useState<string>(MAKER_ALL);

  const items = useMemo(
    () =>
      libraryItems(pages, files).map((item) => ({
        ...item,
        maker: makerOf(item, conversations, dots),
      })),
    [pages, files, conversations, dots],
  );
  const makers = useMemo(() => {
    const seen = new Map<string, { dot: Dot; count: number }>();
    for (const item of items)
      if (item.maker) {
        const entry = seen.get(item.maker.id);
        if (entry) entry.count += 1;
        else seen.set(item.maker.id, { dot: item.maker, count: 1 });
      }
    return [...seen.values()].sort((a, b) => b.count - a.count);
  }, [items]);
  const yours = items.filter((item) => !item.maker).length;

  // Search and the maker narrow what the tabs count; the tab then picks one kind from that.
  const needle = query.trim().toLocaleLowerCase();
  const narrowed = useMemo(
    () =>
      items.filter(
        (item) =>
          (maker === MAKER_ALL ||
            (maker === MAKER_YOU ? !item.maker : item.maker?.id === maker)) &&
          (!needle ||
            `${item.title} ${item.page?.content ?? ''}`
              .toLocaleLowerCase()
              .includes(needle)),
      ),
    [items, maker, needle],
  );
  const counts = useMemo(() => {
    const totals: Record<string, number> = { all: narrowed.length };
    for (const item of narrowed)
      totals[item.category] = (totals[item.category] ?? 0) + 1;
    return totals;
  }, [narrowed]);
  const shown = useMemo(
    () =>
      narrowed
        .filter((item) => tab === 'all' || item.category === tab)
        .sort((a, b) =>
          sort === 'name'
            ? a.title.localeCompare(b.title)
            : b.updatedAt - a.updatedAt || a.title.localeCompare(b.title),
        ),
    [narrowed, tab, sort],
  );
  // In order of time, the shelf is split by age. By name it is one run.
  const shelves =
    sort === 'recent'
      ? AGE_GROUPS.map((label) => ({
          label,
          items: shown.filter(
            (item) => ageGroup(item.updatedAt, now) === label,
          ),
        })).filter((shelf) => shelf.items.length)
      : [{ label: 'A to Z', items: shown }];
  const filtering = !!needle || tab !== 'all' || maker !== MAKER_ALL;
  const open = (item: LibraryItem) =>
    item.type === 'page' ? onPage(item.id) : onFile(item.id);

  return (
    <section
      className={`space-library${dragging ? ' is-dragging' : ''}`}
      aria-label={`${space.name} library`}
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes('Files')) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setDragging(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragging(false);
        if (event.dataTransfer.files.length)
          onUpload(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="library-heading">
        <div>
          <span className="library-eyebrow">SPACE</span>
          <h1>{space.name}</h1>
          {space.description && <p>{space.description}</p>}
        </div>
        <div className="library-actions">
          <button
            type="button"
            className="document-secondary"
            onClick={() => picker.current?.click()}
          >
            <Upload size={16} /> Upload files
          </button>
          <button className="document-primary" onClick={onNew}>
            <Plus size={17} /> New page
          </button>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            aria-label="Choose files to upload"
            onChange={(event) => {
              if (event.target.files?.length)
                onUpload(Array.from(event.target.files));
              event.target.value = '';
            }}
          />
        </div>
      </header>

      <div className="library-tools">
        <label className="library-search">
          <Search size={17} />
          <input
            aria-label="Search pages and files"
            placeholder="Search pages and files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <label className="library-sort">
          <span className="sr-only">Sort the library</span>
          <select
            aria-label="Sort the library"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="recent">Recently edited</option>
            <option value="name">Name A–Z</option>
          </select>
        </label>
        <div
          className="library-view-toggle"
          role="group"
          aria-label="Library view"
        >
          <button
            aria-label="Grid view"
            aria-pressed={layout === 'grid'}
            onClick={() => setLayout('grid')}
          >
            <LayoutGrid size={17} />
          </button>
          <button
            aria-label="List view"
            aria-pressed={layout === 'list'}
            onClick={() => setLayout('list')}
          >
            <List size={18} />
          </button>
        </div>
      </div>

      {items.length > 0 && (
        <div className="lib-filters">
          <div className="lib-tabs" role="group" aria-label="Kind">
            {LIBRARY_TABS.filter(
              ({ id }) => id === 'all' || counts[id] || tab === id,
            ).map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={tab === id}
                onClick={() => setTab(id)}
              >
                {label} <span>{counts[id] ?? 0}</span>
              </button>
            ))}
          </div>
          {makers.length > 0 && (
            <div className="lib-makers" role="group" aria-label="Made by">
              <button
                type="button"
                aria-pressed={maker === MAKER_ALL}
                onClick={() => setMaker(MAKER_ALL)}
              >
                Everyone
              </button>
              {yours > 0 && (
                <button
                  type="button"
                  aria-pressed={maker === MAKER_YOU}
                  onClick={() => setMaker(MAKER_YOU)}
                >
                  <UserRound size={14} aria-hidden /> You <span>{yours}</span>
                </button>
              )}
              {makers.map(({ dot, count }) => (
                <button
                  key={dot.id}
                  type="button"
                  aria-pressed={maker === dot.id}
                  onClick={() => setMaker(dot.id)}
                >
                  <span className="lib-maker-face">
                    <Mascot
                      identity={dot.id}
                      {...dotLook(dot)}
                      name={dot.name}
                      small
                      decorative
                    />
                  </span>
                  {dot.name} <span>{count}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {shelves.map((shelf) => (
        <section key={shelf.label} className="lib-shelf">
          <div className="library-section-label">
            <h2>
              {filtering && shelves.length === 1 ? 'Results' : shelf.label}
            </h2>
            <span>
              {shelf.items.length} {shelf.items.length === 1 ? 'item' : 'items'}
            </span>
          </div>
          <ul className={`lib-items ${layout}`}>
            {shelf.items.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className={`lib-item is-${item.category}`}
                  onClick={() => open(item)}
                >
                  {item.file?.kind === 'image' ? (
                    <Thumbnail file={item.file} />
                  ) : item.page ? (
                    <span className="lib-preview">
                      {pageExcerpt(item.page.content) ||
                        'An empty page, ready to write.'}
                    </span>
                  ) : (
                    <span className="lib-tile">
                      <FileKindIcon
                        kind={item.file?.kind ?? 'download'}
                        size={26}
                        strokeWidth={1.4}
                      />
                    </span>
                  )}
                  <span className="lib-body">
                    <span className="lib-title">
                      <span className="lib-badge">{item.badge}</span>
                      <strong>{item.title}</strong>
                    </span>
                    <span className="lib-meta">
                      <MakerMark dot={item.maker} />
                      <span title={new Date(item.updatedAt).toLocaleString()}>
                        {item.file ? `${formatBytes(item.file.size)} · ` : ''}
                        {shortDate(item.updatedAt)}
                      </span>
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      {!shown.length && (
        <div className="library-empty">
          <FileText size={30} strokeWidth={1.3} />
          <h2>{filtering ? 'Nothing matches' : 'Nothing here yet'}</h2>
          <p>
            {filtering
              ? 'Try another word, kind or maker.'
              : 'Write a page, drop in a file, or ask a Dot to save its work to this Space.'}
          </p>
          {!filtering && (
            <button className="document-primary" onClick={onNew}>
              <Plus size={16} /> New page
            </button>
          )}
        </div>
      )}
      {dragging && <p className="lib-drop">Drop files to add them here</p>}
    </section>
  );
}
