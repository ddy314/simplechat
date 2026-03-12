import { Paper } from "@mui/material";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

export function MarkdownMessage({
  markdown,
  outgoing
}: {
  markdown: string;
  outgoing: boolean;
}) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 2,
        maxWidth: "min(72ch, 100%)",
        borderRadius: 6,
        bgcolor: outgoing ? "primary.main" : "background.paper",
        color: outgoing ? "primary.contrastText" : "text.primary",
        border: outgoing ? "none" : "1px solid",
        borderColor: "divider"
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {markdown}
      </ReactMarkdown>
    </Paper>
  );
}

