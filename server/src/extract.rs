/// Extracted mermaid code block from a markdown file.
#[derive(Debug, Clone)]
pub struct MermaidBlock {
    pub source: String,
    pub line_start: u32, // 1-based, line of the opening fence
    pub line_end: u32,   // 1-based, last line of diagram source (before closing fence)
}

/// Extract all mermaid blocks from markdown-like content.
///
/// Supports fenced code blocks with ` ``` ` or `~~~` and the info strings
/// `mermaid` or `mmd`. Line numbers are 1-based:
/// - `line_start` points to the opening fence line.
/// - `line_end` points to the last source line inside the fence.
pub fn extract_blocks_accurate(content: &str) -> Vec<MermaidBlock> {
    let mut blocks = Vec::new();
    let lines: Vec<&str> = content.split('\n').collect();

    let mut i = 0;
    while i < lines.len() {
        let line = lines[i].trim();

        if let Some(fence_info) = parse_fence_line(line) {
            let opening_line = i;
            let fence_char = fence_info.char;
            let fence_len = fence_info.len;
            let lang = fence_info.lang;

            if lang == "mermaid" || lang == "mmd" {
                let mut source_lines: Vec<&str> = Vec::new();
                let mut j = i + 1;

                while j < lines.len() {
                    let next = lines[j].trim();
                    if next == fence_char.to_string().repeat(fence_len) {
                        let line_start = (opening_line + 1) as u32;
                        let line_end = line_start + source_lines.len() as u32;
                        let source = source_lines.join("\n");

                        blocks.push(MermaidBlock {
                            source,
                            line_start,
                            line_end,
                        });
                        i = j + 1;
                        break;
                    }
                    // Strip trailing \r so CRLF files don't leak into the source.
                    source_lines.push(lines[j].trim_end_matches('\r'));
                    j += 1;
                }

                if j >= lines.len() {
                    // Unclosed fence: treat rest of file as block. If the
                    // content ended with \n, split() produced a phantom empty
                    // final element — drop it so line numbers stay accurate.
                    if !source_lines.is_empty() && source_lines.last().is_some_and(|l| l.is_empty())
                    {
                        source_lines.pop();
                    }
                    let line_start = (opening_line + 1) as u32;
                    let line_end = line_start + source_lines.len() as u32;
                    let source = source_lines.join("\n");
                    blocks.push(MermaidBlock {
                        source,
                        line_start,
                        line_end,
                    });
                    i = lines.len();
                }
            } else {
                i += 1;
            }
        } else {
            i += 1;
        }
    }

    blocks
}

struct FenceInfo {
    char: char,
    len: usize,
    lang: String,
}

fn parse_fence_line(line: &str) -> Option<FenceInfo> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }

    let ch = trimmed.chars().next()?;
    if ch != '`' && ch != '~' {
        return None;
    }

    let mut count = 0;
    for c in trimmed.chars() {
        if c == ch {
            count += 1;
        } else {
            break;
        }
    }

    if count < 3 {
        return None;
    }

    // Only the first word of the info string identifies the language
    // (```mermaid title=x and ```mmd {params} must still match).
    let lang = trimmed[count..]
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string();
    Some(FenceInfo {
        char: ch,
        len: count,
        lang,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_single_block() {
        let content = r#"# Title

Some text

```mermaid
flowchart TD
  A --> B
```

More text"#;

        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, "flowchart TD\n  A --> B");
        assert_eq!(blocks[0].line_start, 5);
        assert_eq!(blocks[0].line_end, 7);
    }

    #[test]
    fn test_multiple_blocks() {
        let content = r#"```mermaid
graph TD
  A --> B
```

Some text

```mermaid
sequenceDiagram
  A->>B: Hello
```"#;

        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].source, "graph TD\n  A --> B");
        assert_eq!(blocks[1].source, "sequenceDiagram\n  A->>B: Hello");
    }

    #[test]
    fn test_mmd_shorthand() {
        let content = "```mmd\nflowchart LR\n  A --> B\n```";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, "flowchart LR\n  A --> B");
    }

    #[test]
    fn test_no_blocks() {
        let content = "# Just a regular markdown file\n\nNo diagrams here.";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 0);
    }

    #[test]
    fn test_empty_block() {
        let content = "```mermaid\n```";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, "");
    }

    #[test]
    fn test_tilde_fence() {
        let content = "~~~mermaid\nflowchart TD\n  A --> B\n~~~";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, "flowchart TD\n  A --> B");
    }

    #[test]
    fn test_fence_with_info_string() {
        let content = "```mermaid title=My Flow\nflowchart TD\n  A --> B\n```";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, "flowchart TD\n  A --> B");
    }

    #[test]
    fn test_crlf_line_endings() {
        let content = "# Title\r\n\r\n```mermaid\r\nflowchart TD\r\n  A --> B\r\n```\r\n";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        // No stray \r should leak into the source.
        assert_eq!(blocks[0].source, "flowchart TD\n  A --> B");
        assert_eq!(blocks[0].line_start, 3);
        assert_eq!(blocks[0].line_end, 5);
    }

    #[test]
    fn test_unclosed_fence() {
        let content = "```mermaid\nflowchart TD\n  A --> B\n";
        let blocks = extract_blocks_accurate(content);
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].source, "flowchart TD\n  A --> B");
    }
}
