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
        display: "inline-block",
        width: "fit-content",
        maxWidth: "min(32rem, calc(100vw - 7rem))",
        px: 2,
        py: 1.1,
        borderRadius: outgoing ? "20px 20px 8px 20px" : "20px 20px 20px 8px",
        bgcolor: outgoing ? "#bfe2ff" : "rgba(255,255,255,0.92)",
        color: "text.primary",
        border: "1px solid",
        borderColor: outgoing ? "rgba(120, 175, 220, 0.42)" : "divider",
        boxShadow: outgoing
          ? "0 8px 18px rgba(74, 144, 226, 0.12)"
          : "0 8px 20px rgba(22, 33, 30, 0.06)",
        overflowWrap: "anywhere",
        lineHeight: 1.5,
        "& > *:first-of-type": {
          marginTop: 0
        },
        "& > *:last-child": {
          marginBottom: 0
        },
        "& p": {
          margin: 0,
          whiteSpace: "pre-wrap"
        },
        "& p + p": {
          marginTop: 1.2
        },
        "& ul, & ol": {
          margin: "0.35rem 0 0",
          paddingLeft: "1.25rem"
        },
        "& li + li": {
          marginTop: "0.2rem"
        },
        "& pre": {
          margin: "0.75rem 0 0",
          padding: "0.85rem 1rem",
          borderRadius: 3,
          overflowX: "auto",
          backgroundColor: "rgba(15, 23, 21, 0.08)"
        },
        "& code": {
          fontFamily: '"Cascadia Code", "Consolas", monospace',
          fontSize: "0.9em"
        },
        "& :not(pre) > code": {
          padding: "0.12rem 0.38rem",
          borderRadius: 1.5,
          backgroundColor: "rgba(15, 23, 21, 0.08)"
        },
        "& blockquote": {
          margin: "0.75rem 0 0",
          paddingLeft: "0.9rem",
          borderLeft: "3px solid rgba(47, 111, 103, 0.25)",
          color: "text.secondary"
        },
        "& a": {
          color: "inherit"
        }
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {markdown}
      </ReactMarkdown>
    </Paper>
  );
}
