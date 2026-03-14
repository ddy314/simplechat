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
  const bubbleColor = outgoing ? "#95ec69" : "#ffffff";
  const bubbleBorderColor = outgoing ? "rgba(67, 145, 44, 0.22)" : "rgba(24, 45, 41, 0.1)";
  const bubbleShadow = outgoing
    ? "0 10px 22px rgba(83, 150, 59, 0.14)"
    : "0 10px 22px rgba(22, 33, 30, 0.08)";

  return (
    <Paper
      elevation={0}
      sx={{
        position: "relative",
        display: "block",
        width: "fit-content",
        maxWidth: "min(100%, 42rem)",
        px: 2,
        py: 1.25,
        borderRadius: outgoing ? "18px 6px 18px 18px" : "6px 18px 18px 18px",
        bgcolor: bubbleColor,
        color: "text.primary",
        border: "1px solid",
        borderColor: bubbleBorderColor,
        boxShadow: bubbleShadow,
        overflow: "visible",
        overflowWrap: "break-word",
        wordBreak: "break-word",
        lineHeight: 1.5,
        "&::after": {
          content: '""',
          position: "absolute",
          bottom: "14px",
          width: "12px",
          height: "12px",
          backgroundColor: bubbleColor,
          borderBottom: `1px solid ${bubbleBorderColor}`,
          transform: "rotate(45deg)",
          ...(outgoing
            ? {
                right: "-6px",
                borderRight: `1px solid ${bubbleBorderColor}`
              }
            : {
                left: "-6px",
                borderLeft: `1px solid ${bubbleBorderColor}`
              })
        },
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
          color: outgoing ? "#165a19" : "#0a67c2",
          overflowWrap: "anywhere",
          wordBreak: "break-all"
        }
      }}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
        {markdown}
      </ReactMarkdown>
    </Paper>
  );
}
