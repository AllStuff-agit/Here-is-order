'use client';

import * as React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { Bell, Boxes, LayoutDashboard, LogOut, Menu, Package, ReceiptText, Settings } from 'lucide-react';
import { apiGet, apiPost, ApiError } from '@/lib/api';
import { INVENTORY_REFRESH_EVENT } from '@/lib/constants';
import type { CurrentUser, DashboardData } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const navItems = [
  { href: '/dashboard', label: '대시보드', icon: LayoutDashboard, description: '전체 현황' },
  { href: '/items', label: '품목관리', icon: Boxes, description: '재고/단가' },
  { href: '/orders', label: '발주관리', icon: ReceiptText, description: '발주/입고' },
  { href: '/alerts', label: '발주 알림', icon: Package, description: '부족 품목' },
  { href: '/settings', label: '설정', icon: Settings, description: '계정/보안' },
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
          ? 'bg-sidebar-accent text-sidebar-accent-foreground shadow-xs'
          : 'text-sidebar-foreground/70 hover:bg-white/10 hover:text-sidebar-foreground',
      )}
      aria-current={active ? 'page' : undefined}
    >
      <Icon className="size-4 shrink-0 text-sidebar-foreground/50 group-hover:text-sidebar-foreground" />
      <span className="font-medium">{item.label}</span>
      <span className="ml-auto hidden truncate text-xs text-sidebar-foreground/40 md:inline">{item.description}</span>
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
  const [currentUser, setCurrentUser] = React.useState<CurrentUser | null>(null);

  const loadAlerts = React.useCallback(async () => {
    setLoading(true);
    setShellError('');
    try {
      const [dashData, meData] = await Promise.all([
        apiGet<DashboardData>('/api/dashboard'),
        apiGet<CurrentUser>('/api/users/me'),
      ]);
      setLowStockCount(Number(dashData?.low_stock_count || 0));
      setCurrentUser(meData);
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

  const visibleNavItems = currentUser?.role === 'admin' ? navItems : navItems.filter((item) => item.href !== '/settings');

  if (isPublicPage) {
    return <>{children}</>;
  }

  return (
    <div className="app-shell">
      <header className="sticky top-0 z-30 border-b border-sidebar-border bg-sidebar text-sidebar-foreground">
        <div className="mx-auto flex h-[56px] w-full max-w-7xl items-center gap-2 px-4 md:px-6">
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon-sm" className="md:hidden" aria-label="메뉴 열기">
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="w-[84vw] bg-sidebar text-sidebar-foreground sm:w-[360px]">
              <SheetHeader className="space-y-1">
                <SheetTitle className="text-sidebar-foreground">Here is order</SheetTitle>
                <SheetDescription className="text-sidebar-foreground/50">재고·발주 관리 앱</SheetDescription>
              </SheetHeader>
              <div className="mt-4">
                <div className="rounded-lg bg-sidebar p-2">
                  <nav className="space-y-1">
                    {visibleNavItems.map((item) => (
                      <TopNavItem
                        key={item.href}
                        item={item}
                        pathname={pathname}
                        onNavigate={() => setMobileOpen(false)}
                      />
                    ))}
                  </nav>
                </div>
              </div>
            </SheetContent>
          </Sheet>

          <Link href="/dashboard" className="inline-flex items-center font-semibold">
            <span className="text-base md:text-lg">Here is order</span>
          </Link>

          <Badge variant={statusTone(lowStockCount)} className="ml-1 gap-1">
            <Bell className="size-3" />
            {loading ? '확인중...' : `발주 필요 ${lowStockCount}개`}
          </Badge>

          <div className="ml-auto flex items-center gap-2">
            {currentUser?.username ? (
              <span className="text-sm text-sidebar-foreground/60">{currentUser.username}</span>
            ) : null}
            <Button variant="ghost" size="sm" className="text-sidebar-foreground/70 hover:bg-white/10 hover:text-sidebar-foreground" onClick={handleLogout}>
              <LogOut className="size-4" />
              로그아웃
            </Button>
          </div>
        </div>
        {shellError ? <p className="mx-auto max-w-7xl px-4 pb-2 text-sm text-destructive md:px-6">{shellError}</p> : null}
      </header>

      <div className="app-shell-shell">
        <aside className="hidden w-64 shrink-0 md:block">
          <div className="overflow-hidden rounded-lg bg-sidebar p-2">
            <p className="px-2 py-2 text-xs font-semibold uppercase tracking-wide text-sidebar-foreground/40">메뉴</p>
            <div className="border-b border-sidebar-border" />
            <nav className="space-y-1 p-2">
              {visibleNavItems.map((item) => (
                <TopNavItem key={item.href} item={item} pathname={pathname} />
              ))}
            </nav>
          </div>
        </aside>

        <main className="content-shell">{children}</main>
      </div>

    </div>
  );
}
