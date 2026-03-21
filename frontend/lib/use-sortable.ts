import * as React from 'react';

export type SortDir = 'asc' | 'desc' | null;

export type SortState = {
  key: string | null;
  dir: SortDir;
};

export function useSortable<T>(data: T[]) {
  const [sort, setSort] = React.useState<SortState>({ key: null, dir: null });

  const toggle = React.useCallback((key: string) => {
    setSort((prev) => {
      if (prev.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return { key: null, dir: null };
    });
  }, []);

  const sorted = React.useMemo(() => {
    if (!sort.key || !sort.dir) return data;
    const k = sort.key;
    const dir = sort.dir;
    return [...data].sort((a, b) => {
      const av = (a as Record<string, unknown>)[k];
      const bv = (b as Record<string, unknown>)[k];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') {
        cmp = av - bv;
      } else {
        cmp = String(av).localeCompare(String(bv), 'ko');
      }
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [data, sort]);

  return { sorted, sort, toggle };
}
