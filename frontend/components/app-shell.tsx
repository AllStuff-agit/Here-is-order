'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, Boxes, Home, LayoutDashboard, LogOut, Menu, Package, ReceiptText } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { INVENTORY_REFRESH_EVENT } from '@/lib/constants';
import type { DashboardData } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/dashboard', label: '대시보드', icon: LayoutDashboard, description: '전체 현황' },
  { href: '/items', label: '품목관리', icon: Boxes, description: '재고/단가' },
  { href: '/orders', label: '발주관리', icon: ReceiptText, description: '발주/입고' },
  { href: '/alerts', label: '발주 알림', icon: Package, description: '부족 품목' },
];

function statusTone(count: number) {
  if (count >= 20) return 'destructive';
  if (count >= 8) return 'secondary';
  return 'default';
}

function TopNavItem({
  item,
  pathname,
  onNavigate,
}: {
  item: (typeof navItems)[number];
  pathname: string;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const active = pathname === item.href;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition',
        active
          ? 'bg-sidebar-accent text-foreground shadow-xs'
          : 'text-muted-foreground hover:bg-background/80 hover:text-foreground',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
      <span className="font-medium">{item.label}</span>
      <span className="ml-auto hidden truncate text-xs text-muted-foreground md:inline">{item.description}</span>
    </Link>
  );
}

function MobileNavItem({
  item,
  pathname,
  lowStockCount,
  onNavigate,
}: {
  item: (typeof navItems)[number];
  pathname: string;
  lowStockCount: number;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const active = pathname === item.href;
  const showBadge = item.href === '/alerts' && lowStockCount > 0;

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={cn(
        'relative flex min-h-14 flex-col items-center justify-center gap-1 rounded-lg px-2 transition',
        active
          ? 'bg-muted text-foreground'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
      aria-current={active ? 'page' : undefined}
    >
      {showBadge ? (
        <Badge
          variant={statusTone(lowStockCount)}
          className="absolute right-1.5 top-1.5 h-4 min-w-4 px-1 text-[10px]"
        >
          {lowStockCount}
        </Badge>
      ) : null}
      <Icon className="size-4" />
      <span className="text-[11px]">{item.label}</span>
    </Link>
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const isPublicPage = pathname === '/' || pathname === '/login' || pathname.startsWith('/login');
  const [loading, setLoading] = React.useState(false);
  const [lowStockCount, setLowStockCount] = React.useState(0);
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [shellError, setShellError] = React.useState('');

  const loadAlerts = React.useCallback(async () => {
    setLoading(true);
    setShellError('');
    try {
      const data = await apiGet<DashboardData>('/api/dashboard');
      setLowStockCount(Number(data?.low_stock_count || 0));
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        router.replace('/login');
        return;
      }
      setShellError(error instanceof Error ? error.message : '알림 정보를 불러오지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }, [router]);

  React.useEffect(() => {
    if (isPublicPage) {
      return;
    }

    void loadAlerts();
  }, [isPublicPage, loadAlerts]);

  React.useEffect(() => {
    if (isPublicPage) {
      return;
    }

    const onInventoryStateUpdated = () => {
      void loadAlerts();
    };

    window.addEventListener(INVENTORY_REFRESH_EVENT, onInventoryStateUpdated);
    return () => window.removeEventListener(INVENTORY_REFRESH_EVENT, onInventoryStateUpdated);
  }, [isPublicPage, loadAlerts]);

  const handleLogout = async () => {
    try {
      await apiPost('/api/auth/logout');
    } finally {
      router.replace('/login');
    }
  };

  if (isPublicPage) {
    return <>{children}</>;
  }

  return (
    <div className="app-shell">
      <header className="sticky top-0 z-30 border-b border-border/70 bg-background/95 backdrop-blur">
        <div className="mx-auto flex h-[56px] w-full max-w-7xl items-center gap-2 px-4 md:px-6">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="메뉴 열기">
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[84vw] sm:w-[360px]">
              <SheetHeader className="space-y-1">
                <SheetTitle>카페 발주 관리</SheetTitle>
                <SheetDescription>관리자 전용 앱</SheetDescription>
              </SheetHeader>
              <div className="mt-4">
                <Card className="p-2">
                  <nav className="space-y-1">
                    {navItems.map((item) => (
                      <TopNavItem
                        key={item.href}
                        item={item}
                        pathname={pathname}
                        onNavigate={() => setMobileOpen(false)}
                      />
                    ))}
                  </nav>
                </Card>
              </div>
            </SheetContent>
          </Sheet>

          <Link href="/dashboard" className="inline-flex items-center gap-2 font-semibold">
            <Home className="size-4 text-primary" />
            <span className="text-sm md:text-base">카페 발주 관리</span>
          </Link>

          <Badge variant={statusTone(lowStockCount)} className="ml-1 gap-1">
            <Bell className="size-3" />
            {loading ? '확인중...' : `발주 필요 ${lowStockCount}개`}
          </Badge>

          <div className="ml-auto">
            <Button variant="ghost" size="sm" onClick={handleLogout}>
              <LogOut className="size-4" />
              로그아웃
            </Button>
          </div>
        </div>
        {shellError ? <p className="mx-auto max-w-7xl px-4 pb-2 text-sm text-destructive md:px-6">{shellError}</p> : null}
      </header>

      <div className="app-shell-shell">
        <aside className="hidden w-64 shrink-0 md:block">
          <Card className="overflow-hidden p-2">
            <p className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">메뉴</p>
            <Separator />
            <nav className="space-y-1 p-2">
              {navItems.map((item) => (
                <TopNavItem key={item.href} item={item} pathname={pathname} />
              ))}
            </nav>
          </Card>
        </aside>

        <main className="content-shell">{children}</main>
      </div>

      <nav className="fixed right-0 bottom-0 left-0 z-20 border-t border-border/70 bg-background/95 px-2 py-2 backdrop-blur md:hidden">
        <div className="app-shell-shell !max-w-7xl !px-0 !py-0">
          {navItems.map((item) => (
            <MobileNavItem
              key={item.href}
              item={item}
              pathname={pathname}
              lowStockCount={lowStockCount}
              onNavigate={() => {}}
            />
          ))}
        </div>
      </nav>
      <div className="h-16 md:hidden" />
    </div>
  );
}
