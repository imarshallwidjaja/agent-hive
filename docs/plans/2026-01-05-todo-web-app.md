# Todo Web App Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a simple, responsive frontend-only Todo application using Next.js, React, and Tailwind CSS.

**Architecture:** A single-page application using React's `useState` for state management and `localStorage` for data persistence. The UI will be built with Tailwind CSS for rapid styling.

**Tech Stack:** Next.js (App Router), React, Tailwind CSS, Lucide-React (icons).

---

### Task 1: Project Initialization

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `tailwind.config.ts`
- Create: `postcss.config.js`

**Step 1: Setup project structure**
Initialize a new Next.js project with Tailwind CSS.

**Step 2: Commit**
```bash
git add .
git commit -m "chore: initial project setup with Next.js and Tailwind"
```

### Task 2: Core Todo Logic & State

**Files:**
- Create: `src/hooks/useTodos.ts`

**Step 1: Implement the useTodos hook**
Create a custom hook to manage todo state and localStorage persistence.

```typescript
import { useState, useEffect } from 'react';

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export function useTodos() {
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('todos');
    if (saved) {
      setTodos(JSON.parse(saved));
    }
    setIsInitialized(true);
  }, []);

  useEffect(() => {
    if (isInitialized) {
      localStorage.setItem('todos', JSON.stringify(todos));
    }
  }, [todos, isInitialized]);

  const addTodo = (text: string) => {
    const newTodo: Todo = { id: crypto.randomUUID(), text, completed: false };
    setTodos([...todos, newTodo]);
  };

  const toggleTodo = (id: string) => {
    setTodos(todos.map(t => t.id === id ? { ...t, completed: !t.completed } : t));
  };

  const deleteTodo = (id: string) => {
    setTodos(todos.filter(t => t.id !== id));
  };

  return { todos, addTodo, toggleTodo, deleteTodo };
}
```

**Step 2: Commit**
```bash
git add src/hooks/useTodos.ts
git commit -m "feat: add useTodos hook for state management"
```

### Task 3: Main UI Components

**Files:**
- Create: `src/app/page.tsx`
- Create: `src/components/TodoItem.tsx`
- Create: `src/components/AddTodo.tsx`

**Step 1: Create AddTodo component**
A simple form to input and add new tasks.

**Step 2: Create TodoItem component**
Display individual tasks with toggle and delete actions.

**Step 3: Assemble in Page component**
Main layout for the application.

**Step 4: Commit**
```bash
git add src/app/page.tsx src/components/
git commit -m "feat: implement main UI components"
```
