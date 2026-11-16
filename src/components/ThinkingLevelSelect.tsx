import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useI18n } from "@/i18n";
import {
  canonicalThinkingLevel,
  thinkingLevelOptions,
} from "@/lib/thinking-levels";

export interface ThinkingLevelSelectProps {
  value: string;
  onChange: (level: string) => void;
  levels?: readonly string[] | null;
  triggerClassName?: string;
}

export default function ThinkingLevelSelect({
  value,
  onChange,
  levels,
  triggerClassName = "h-8 w-32 text-xs",
}: ThinkingLevelSelectProps) {
  const { t } = useI18n();
  const options = thinkingLevelOptions(levels, value);

  return (
    <Select value={canonicalThinkingLevel(value)} onValueChange={onChange}>
      <SelectTrigger className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((level) => (
          <SelectItem key={level} value={level}>
            {t(`thinkingLevel.${level}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
