import type { LucideIcon } from "lucide-react";

import { SettingsCard } from "@/components/settings/settings-card";
import { SettingsCardHeader } from "@/components/settings/_card-header";

export interface ImportCardShellProps {
  testId: string;
  icon: LucideIcon;
  title: string;
  description: string;
  children: React.ReactNode;
}

export function ImportCardShell({
  testId,
  icon: Icon,
  title,
  description,
  children,
}: ImportCardShellProps) {
  return (
    <SettingsCard data-testid={testId} className="flex h-full flex-col">
      <SettingsCardHeader icon={Icon} title={title} description={description} />
      <div className="flex flex-1 flex-col gap-3">{children}</div>
    </SettingsCard>
  );
}
