import { AlertCircle } from "lucide-react"

interface ErrorStateProps {
  message?: string;
}

export function ErrorState({ message = "Произошла ошибка при загрузке данных" }: ErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center p-8 text-center text-destructive">
      <AlertCircle className="w-10 h-10 mb-4 opacity-80" />
      <p className="font-medium">{message}</p>
    </div>
  )
}
