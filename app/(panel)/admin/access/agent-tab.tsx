"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import type { AccessData } from "@/lib/web/access-data.ts";
import type { Run } from "./access-client.tsx";
import { saveLanguages } from "./actions.ts";

function LanguageSelect({
  id,
  options,
  value,
  onChange,
}: {
  id: string;
  options: AccessData["languageOptions"];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <Select items={options} value={value} onValueChange={(next) => next && onChange(next as string)}>
      <SelectTrigger id={id} className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

export function AgentTab({ data, run, pending }: { data: AccessData; run: Run; pending: boolean }) {
  const [languages, setLanguages] = useState(data.languages);
  const changed = languages.internal !== data.languages.internal || languages.external !== data.languages.external;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Language</CardTitle>
        <CardDescription>
          The language Manfrod writes in by default. It goes into every system prompt; in a DM someone can still ask for another language.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            run(() => saveLanguages(languages.internal, languages.external));
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="language-internal">Internal</FieldLabel>
              <LanguageSelect
                id="language-internal"
                options={data.languageOptions}
                value={languages.internal}
                onChange={(internal) => setLanguages({ ...languages, internal: internal as typeof languages.internal })}
              />
              <FieldDescription>DMs and the team&apos;s own channels, including internal project channels.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="language-external">Client channels</FieldLabel>
              <LanguageSelect
                id="language-external"
                options={data.languageOptions}
                value={languages.external}
                onChange={(external) => setLanguages({ ...languages, external: external as typeof languages.external })}
              />
              <FieldDescription>Official channels shared with a client, the ones mapped to a client in Channels.</FieldDescription>
            </Field>
          </FieldGroup>
          <div>
            <Button type="submit" disabled={pending || !changed}>
              {pending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
