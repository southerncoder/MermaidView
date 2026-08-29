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
                    source_lines.push(lines[j]);
                    j += 1;
                }

                if j >= lines.len() {
                    // Unclosed fence: treat rest of file as block.
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

    let lang = trimmed[count..].trim().to_string();
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
}
