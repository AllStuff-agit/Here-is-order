'use client';

import * as React from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { TableHead } from '@/components/ui/table';
import { type SortState } from '@/lib/use-sortable';
import { cn } from '@/lib/utils';

interface SortableHeaderProps {
  label: string;
  sortKey: string;
  sort: SortState;
  onSort: (key: string) => void;
  className?: string;
}

export function SortableHeader({ label, sortKey, sort, onSort, className }: SortableHeaderProps) {
  const isActive = sort.key === sortKey;
  const Icon = !isActive || !sort.dir
    ? ArrowUpDown
    : sort.dir === 'asc'
    ? ArrowUp
    : ArrowDown;

  return (
    <TableHead
      className={cn('cursor-pointer select-none whitespace-nowrap hover:bg-muted/50', className)}
      onClick={() => onSort(sortKey)}
    >
      <div className="inline-flex items-center gap-1">
        {label}
        <Icon className={cn('size-3', isActive && sort.dir ? 'opacity-80' : 'opacity-30')} />
      </div>
    </TableHead>
  );
}
