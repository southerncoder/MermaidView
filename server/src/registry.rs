use std::collections::{HashMap, HashSet};
use std::sync::mpsc::Sender;

/// Represents a single mermaid diagram extracted from a source file.
#[derive(Debug, Clone, serde::Serialize)]
pub struct Diagram {
    pub id: String,
    pub source: String,
    pub file: String,
    pub line_start: u32,
    pub line_end: u32,
    pub content_hash: u64,
}

/// Registry of all known diagrams across open documents.
#[derive(Debug)]
pub struct DiagramRegistry {
    /// All diagrams indexed by unique id (file:line_start)
    diagrams: HashMap<String, Diagram>,
    /// Subscribers receive JSON payloads on every change.
    subscribers: Vec<Sender<String>>,
    next_subscriber_id: usize,
}

impl DiagramRegistry {
    pub fn new() -> Self {
        Self {
            diagrams: HashMap::new(),
            subscribers: Vec::new(),
            next_subscriber_id: 0,
        }
    }

    /// Subscribe to diagram changes. Returns a receiver on a new channel and
    /// immediately sends the current state.
    pub fn subscribe_json(&mut self) -> (usize, std::sync::mpsc::Receiver<String>) {
        let (tx, rx) = std::sync::mpsc::channel();
        let id = self.next_subscriber_id;
        self.next_subscriber_id += 1;
        self.subscribers.push(tx.clone());

        let payload = serde_json::json!({
            "type": "init",
            "diagrams": self.diagrams.values().collect::<Vec<_>>(),
        });
        let _ = tx.send(payload.to_string());

        (id, rx)
    }

    /// Update diagrams for a specific file. Returns list of changed diagram IDs.
    pub fn update_file(
        &mut self,
        file: &str,
        new_diagrams: Vec<(String, u32, u32)>,
    ) -> Vec<String> {
        let mut changed = Vec::new();

        // Snapshot existing diagrams for this file so we can detect adds/edits/removes.
        let old_by_id: HashMap<String, Diagram> = self
            .diagrams
            .iter()
            .filter(|(_, d)| d.file == file)
            .map(|(id, d)| (id.clone(), d.clone()))
            .collect();

        let mut new_ids = HashSet::new();

        for (source, line_start, line_end) in new_diagrams {
            let id = format!("{file}:{line_start}");
            let hash = fast_hash(&source);
            let diagram = Diagram {
                id: id.clone(),
                source,
                file: file.to_string(),
                line_start,
                line_end,
                content_hash: hash,
            };
            new_ids.insert(id.clone());

            let changed_flag = match old_by_id.get(&id) {
                Some(old) => old.content_hash != hash,
                None => true,
            };
            if changed_flag {
                changed.push(id.clone());
            }
            self.diagrams.insert(id, diagram);
        }

        // Remove any old diagrams for this file that are no longer present.
        for id in old_by_id.keys() {
            if !new_ids.contains(id) {
                self.diagrams.remove(id);
                changed.push(id.clone());
            }
        }

        self.notify();
        changed
    }

    /// Remove all diagrams for a closed file.
    pub fn remove_file(&mut self, file: &str) {
        let ids: Vec<_> = self
            .diagrams
            .values()
            .filter(|d| d.file == file)
            .map(|d| d.id.clone())
            .collect();
        for id in ids {
            self.diagrams.remove(&id);
        }
        self.notify();
    }

    /// Get all diagrams as a flat list.
    pub fn all_diagrams(&self) -> Vec<Diagram> {
        self.diagrams.values().cloned().collect()
    }

    /// Get diagrams filtered by file.
    pub fn diagrams_for_file(&self, file: &str) -> Vec<Diagram> {
        self.diagrams
            .values()
            .filter(|d| d.file == file)
            .cloned()
            .collect()
    }

    pub fn notify_custom(&mut self, payload: String) {
        self.subscribers
            .retain(|tx| tx.send(payload.clone()).is_ok());
    }

    fn notify(&mut self) {
        let diagrams: Vec<&Diagram> = self.diagrams.values().collect();
        let payload = serde_json::json!({
            "type": "update",
            "diagrams": diagrams,
        })
        .to_string();

        self.notify_custom(payload);
    }
}

/// Simple hash for change detection (not cryptographic).
fn fast_hash(s: &str) -> u64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    s.hash(&mut hasher);
    hasher.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add_and_detect_change() {
        let mut registry = DiagramRegistry::new();
        let changes = registry.update_file(
            "test.md",
            vec![("flowchart TD\n  A --> B".to_string(), 5, 7)],
        );
        assert_eq!(changes.len(), 1);

        // Update with same content — no change
        let changes = registry.update_file(
            "test.md",
            vec![("flowchart TD\n  A --> B".to_string(), 5, 7)],
        );
        assert_eq!(changes.len(), 0);

        // Update with different content — change detected
        let changes = registry.update_file(
            "test.md",
            vec![("flowchart TD\n  A --> B\n  B --> C".to_string(), 5, 8)],
        );
        assert_eq!(changes.len(), 1);
    }

    #[test]
    fn test_remove_file() {
        let mut registry = DiagramRegistry::new();
        registry.update_file(
            "test.md",
            vec![("flowchart TD\n  A --> B".to_string(), 5, 7)],
        );
        assert_eq!(registry.all_diagrams().len(), 1);
        registry.remove_file("test.md");
        assert_eq!(registry.all_diagrams().len(), 0);
    }
}
