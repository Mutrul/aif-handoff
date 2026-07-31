import { useState } from "react";
import { ChevronDown, LogOut, Users } from "lucide-react";
import type { ParticipantSummary } from "@aif/shared/browser";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface ParticipantMenuProps {
  participant: ParticipantSummary;
  onManageParticipants: () => void;
  onLogout: () => Promise<unknown>;
  isLoggingOut: boolean;
}

export function ParticipantMenu({
  participant,
  onManageParticipants,
  onLogout,
  isLoggingOut,
}: ParticipantMenuProps) {
  const [open, setOpen] = useState(false);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-2 px-2"
          aria-label={`Participant menu for ${participant.displayName}`}
        >
          <Avatar name={participant.displayName} size="sm" />
          <span className="hidden max-w-36 truncate font-mono text-2xs md:inline">
            {participant.displayName}
          </span>
          <Badge size="xs" variant={participant.role === "admin" ? "default" : "secondary"}>
            {participant.role.toUpperCase()}
          </Badge>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <div className="border-b border-border px-2 py-2">
          <p className="truncate text-sm font-medium text-popover-foreground">
            {participant.displayName}
          </p>
          <p className="font-mono text-3xs uppercase text-muted-foreground">Active participant</p>
        </div>
        {participant.role === "admin" && (
          <DropdownMenuItem onClick={onManageParticipants}>
            <Users className="h-4 w-4" />
            Manage participants
          </DropdownMenuItem>
        )}
        <DropdownMenuItem destructive disabled={isLoggingOut} onClick={() => void onLogout()}>
          <LogOut className="h-4 w-4" />
          {isLoggingOut ? "Signing out..." : "Sign out"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
