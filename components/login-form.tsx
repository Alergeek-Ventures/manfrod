"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";
import { authClient } from "@/lib/auth-client";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";

export function LoginForm({ error, className, ...props }: React.ComponentProps<"div"> & { error?: string }) {
  const [pending, setPending] = useState(false);
  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Welcome back</CardTitle>
          <CardDescription>Sign in with your Google account</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <Field>
              <Button
                variant="outline"
                disabled={pending}
                onClick={async () => {
                  setPending(true);
                  await authClient.signIn.social({ provider: "google", callbackURL: "/", errorCallbackURL: "/login" });
                }}
              >
                {pending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" data-icon="inline-start">
                    <path
                      d="M12.48 10.92v3.28h7.84c-.24 1.84-.853 3.187-1.787 4.133-1.147 1.147-2.933 2.4-6.053 2.4-4.827 0-8.6-3.893-8.6-8.72s3.773-8.72 8.6-8.72c2.6 0 4.507 1.027 5.907 2.347l2.307-2.307C18.747 1.44 16.133 0 12.48 0 5.867 0 .307 5.387.307 12s5.56 12 12.173 12c3.573 0 6.267-1.173 8.373-3.36 2.16-2.16 2.84-5.213 2.84-7.667 0-.76-.053-1.467-.173-2.053H12.48z"
                      fill="currentColor"
                    />
                  </svg>
                )}
                Sign in with Google
              </Button>
              <FieldDescription className="text-center">Only @alergeek.ventures accounts</FieldDescription>
            </Field>
          </FieldGroup>
        </CardContent>
      </Card>
    </div>
  );
}
