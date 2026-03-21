'use client';

import * as React from 'react';
import { KeyRound, Plus, UserCog } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiGet, apiPatch, apiPost, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { AppUser } from '@/lib/types';

export default function SettingsPage() {
  const [users, setUsers] = React.useState<AppUser[]>([]);
  const [usersLoading, setUsersLoading] = React.useState(true);
  const [usersError, setUsersError] = React.useState('');

  const [addOpen, setAddOpen] = React.useState(false);
  const [addUsername, setAddUsername] = React.useState('');
  const [addName, setAddName] = React.useState('');
  const [addPassword, setAddPassword] = React.useState('');
  const [addSubmitting, setAddSubmitting] = React.useState(false);
  const [addError, setAddError] = React.useState('');

  const [pwCurrent, setPwCurrent] = React.useState('');
  const [pwNew, setPwNew] = React.useState('');
  const [pwConfirm, setPwConfirm] = React.useState('');
  const [pwSubmitting, setPwSubmitting] = React.useState(false);
  const [pwMessage, setPwMessage] = React.useState('');
  const [pwError, setPwError] = React.useState('');

  const loadUsers = React.useCallback(async () => {
    setUsersLoading(true);
    setUsersError('');
    try {
      const data = await apiGet<AppUser[]>('/api/users');
      setUsers(data);
    } catch (e) {
      setUsersError(e instanceof Error ? e.message : '불러오지 못했습니다.');
    } finally {
      setUsersLoading(false);
    }
  }, []);

  React.useEffect(() => { void loadUsers(); }, [loadUsers]);

  const handleAddUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setAddSubmitting(true);
    setAddError('');
    try {
      await apiPost('/api/users', { username: addUsername, name: addName, password: addPassword });
      setAddOpen(false);
      setAddUsername('');
      setAddName('');
      setAddPassword('');
      await loadUsers();
    } catch (e) {
      setAddError(e instanceof Error ? e.message : '생성에 실패했습니다.');
    } finally {
      setAddSubmitting(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwError('');
    setPwMessage('');
    if (pwNew !== pwConfirm) {
      setPwError('새 비밀번호가 일치하지 않습니다.');
      return;
    }
    setPwSubmitting(true);
    try {
      await apiPatch('/api/users/me/password', { current_password: pwCurrent, new_password: pwNew });
      setPwMessage('비밀번호가 변경되었습니다.');
      setPwCurrent('');
      setPwNew('');
      setPwConfirm('');
    } catch (e) {
      setPwError(e instanceof ApiError ? e.message : '변경에 실패했습니다.');
    } finally {
      setPwSubmitting(false);
    }
  };

  return (
    <div className="section-gap">
      <div className="page-header">
        <div>
          <h1 className="page-title">설정</h1>
          <p className="page-subtitle">계정 관리 및 보안 설정</p>
        </div>
      </div>

      {/* 계정 관리 */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2">
                <UserCog className="size-4" />
                계정 관리
              </CardTitle>
              <CardDescription>로그인 가능한 계정 목록입니다.</CardDescription>
            </div>
            <Dialog open={addOpen} onOpenChange={setAddOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="size-4" />
                  계정 추가
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>계정 추가</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleAddUser} className="space-y-3">
                  <div className="space-y-1.5">
                    <Label>아이디</Label>
                    <Input
                      required
                      autoFocus
                      value={addUsername}
                      onChange={(e) => setAddUsername(e.target.value)}
                      placeholder="영문/숫자"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>이름 (선택)</Label>
                    <Input
                      value={addName}
                      onChange={(e) => setAddName(e.target.value)}
                      placeholder="표시될 이름"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label>비밀번호</Label>
                    <Input
                      required
                      type="password"
                      value={addPassword}
                      onChange={(e) => setAddPassword(e.target.value)}
                      placeholder="6자 이상"
                    />
                  </div>
                  {addError ? <p className="text-sm text-destructive">{addError}</p> : null}
                  <DialogFooter>
                    <Button type="button" variant="outline" onClick={() => setAddOpen(false)}>취소</Button>
                    <Button type="submit" disabled={addSubmitting}>
                      {addSubmitting ? '생성 중...' : '생성'}
                    </Button>
                  </DialogFooter>
                </form>
              </DialogContent>
            </Dialog>
          </div>
        </CardHeader>
        <CardContent>
          {usersLoading ? (
            <div className="space-y-2">
              <div className="h-10 animate-pulse rounded bg-muted" />
              <div className="h-10 animate-pulse rounded bg-muted" />
            </div>
          ) : usersError ? (
            <p className="text-sm text-destructive">{usersError}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>아이디</TableHead>
                  <TableHead>이름</TableHead>
                  <TableHead>상태</TableHead>
                  <TableHead>생성일</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell>{u.name}</TableCell>
                    <TableCell>
                      <Badge variant={u.is_active ? 'secondary' : 'outline'}>
                        {u.is_active ? '활성' : '비활성'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDateTime(u.created_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* 비밀번호 변경 */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            비밀번호 변경
          </CardTitle>
          <CardDescription>현재 로그인된 계정의 비밀번호를 변경합니다.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleChangePassword} className="max-w-sm space-y-3">
            <div className="space-y-1.5">
              <Label>현재 비밀번호</Label>
              <Input
                type="password"
                value={pwCurrent}
                onChange={(e) => setPwCurrent(e.target.value)}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>새 비밀번호</Label>
              <Input
                type="password"
                value={pwNew}
                onChange={(e) => setPwNew(e.target.value)}
                placeholder="6자 이상"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>새 비밀번호 확인</Label>
              <Input
                type="password"
                value={pwConfirm}
                onChange={(e) => setPwConfirm(e.target.value)}
                required
              />
            </div>
            {pwError ? <p className="text-sm text-destructive">{pwError}</p> : null}
            {pwMessage ? <p className="text-sm text-primary">{pwMessage}</p> : null}
            <Button type="submit" disabled={pwSubmitting}>
              {pwSubmitting ? '변경 중...' : '비밀번호 변경'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* 비밀번호 분실 메뉴얼 */}
      <Card>
        <CardHeader>
          <CardTitle>비밀번호를 잊어버렸을 때</CardTitle>
          <CardDescription>Cloudflare D1 콘솔에서 직접 비밀번호를 초기화하는 방법입니다.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ol className="space-y-3 leading-relaxed">
            <li className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">1</span>
              <span><a href="https://dash.cloudflare.com" target="_blank" rel="noreferrer" className="underline underline-offset-2">dash.cloudflare.com</a> 에 로그인합니다.</span>
            </li>
            <li className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">2</span>
              <span>좌측 메뉴에서 <strong>Storage &amp; Databases → D1 SQL Database</strong> 를 클릭합니다.</span>
            </li>
            <li className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">3</span>
              <span><strong>hereisorder</strong> 데이터베이스를 클릭합니다.</span>
            </li>
            <li className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">4</span>
              <span>상단 <strong>Console</strong> 탭을 클릭합니다.</span>
            </li>
            <li className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">5</span>
              <div className="flex-1 space-y-2">
                <span>아래 SQL을 입력하고 <strong>Execute</strong> 버튼을 누릅니다.</span>
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">① 새 비밀번호의 SHA-256 해시를 구합니다.</p>
                  <p className="text-xs text-muted-foreground">→ <a href="https://emn178.github.io/online-tools/sha256.html" target="_blank" rel="noreferrer" className="underline underline-offset-2">SHA-256 온라인 도구</a> 에서 새 비밀번호를 입력하면 해시값이 나옵니다.</p>
                </div>
                <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs leading-relaxed">
{`UPDATE users
SET password_hash = '여기에_SHA256_해시값_붙여넣기'
WHERE username = '아이디';`}
                </pre>
              </div>
            </li>
            <li className="flex gap-2">
              <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">6</span>
              <span>앱으로 돌아와 새 비밀번호로 로그인합니다.</span>
            </li>
          </ol>
        </CardContent>
      </Card>
    </div>
  );
}
