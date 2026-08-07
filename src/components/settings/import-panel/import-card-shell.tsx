import { SettingsCard } from "@/components/settings/settings-card";

export interface ImportCardShellProps {
  testId: string;
  icon: React.ComponentType<{ className?: string }>;
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
      <div className="flex items-center gap-2">
        <Icon
          className="text-muted-foreground h-5 w-5 shrink-0"
          aria-hidden="true"
        />
        <h3 className="text-base font-semibold">{title}</h3>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{description}</p>
      <div className="flex flex-1 flex-col gap-3">{children}</div>
    </SettingsCard>
  );
}
