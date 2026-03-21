'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Coffee, LogIn } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiPost, ApiError } from '@/lib/api';

type LoginResult = {
  user: {
    id: number;
    username: string;
    name: string;
  };
};

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [errorMessage, setErrorMessage] = React.useState('');
  const [loading, setLoading] = React.useState(false);

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password) {
      setErrorMessage('아이디와 비밀번호를 입력해주세요.');
      return;
    }

    setLoading(true);
    setErrorMessage('');

    try {
      await apiPost<LoginResult>('/api/auth/login', {
        username: username.trim(),
        password,
      });
      router.replace('/dashboard');
    } catch (error) {
      if (error instanceof ApiError) {
        setErrorMessage(error.message);
        return;
      }
      setErrorMessage('로그인 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center p-4 md:p-6">
      <div className="w-full max-w-sm">
        <Card className="shadow-sm">
          <CardHeader className="space-y-1 text-center">
            <div className="mx-auto inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Coffee className="size-5" />
            </div>
            <CardTitle className="text-xl">Here is order</CardTitle>
            <CardDescription>관리자 1명 운영용 발주 모니터링 서비스</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4" autoComplete="on">
              <div className="space-y-2">
                <Label htmlFor="username">아이디</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  placeholder="admin"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">비밀번호</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </div>
              {errorMessage ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                  {errorMessage}
                </p>
              ) : null}
              <Button className="w-full" type="submit" disabled={loading}>
                <LogIn className="size-4" />
                {loading ? '로그인 중...' : '로그인'}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
