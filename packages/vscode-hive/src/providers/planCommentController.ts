import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import { reviewTargetForDocument, reviewTargetForComments, reviewDocumentPath, reviewCommentsPath, findReviewCommentsPath } from '../reviewRouting.js'

interface StoredThread {
  id: string
  line: number
  body: string
  replies: string[]
}

interface CommentsFile {
  threads: StoredThread[]
}

export class PlanCommentController {
  private controller: vscode.CommentController
  private threads = new Map<string, vscode.CommentThread>()
  private commentsWatchers: vscode.FileSystemWatcher[] = []

  constructor(private workspaceRoot: string) {
    this.controller = vscode.comments.createCommentController(
      'hive-plan-review',
      'Hive Review'
    )

    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        if (!reviewTargetForDocument(this.workspaceRoot, document.fileName)) return []
        return [new vscode.Range(0, 0, document.lineCount - 1, 0)]
      }
    }

    const patterns = [
      new vscode.RelativePattern(workspaceRoot, '.hive/features/*/comments.json'),
      new vscode.RelativePattern(workspaceRoot, '.hive/features/*/comments/plan.json'),
      new vscode.RelativePattern(workspaceRoot, '.hive/features/*/comments/overview.json')
    ]
    this.commentsWatchers = patterns.map((pattern) => {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern)
      watcher.onDidChange(uri => this.onCommentsFileChanged(uri))
      watcher.onDidDelete(uri => this.onCommentsFileChanged(uri))
      return watcher
    })
  }

  private onCommentsFileChanged(commentsUri: vscode.Uri): void {
    const target = reviewTargetForComments(this.workspaceRoot, commentsUri.fsPath)
    if (!target) return
    this.loadComments(vscode.Uri.file(reviewDocumentPath(this.workspaceRoot, target)))
  }

  registerCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.controller,

      vscode.commands.registerCommand('hive.comment.create', (reply: vscode.CommentReply) => {
        this.createComment(reply)
      }),

      vscode.commands.registerCommand('hive.comment.reply', (reply: vscode.CommentReply) => {
        this.replyToComment(reply)
      }),

      vscode.commands.registerCommand('hive.comment.resolve', (thread: vscode.CommentThread) => {
        thread.dispose()
        this.saveComments(thread.uri)
      }),

      vscode.commands.registerCommand('hive.comment.delete', (comment: vscode.Comment) => {
        for (const [id, thread] of this.threads) {
          const commentIndex = thread.comments.findIndex(c => c === comment)
          if (commentIndex !== -1) {
            thread.comments = thread.comments.filter(c => c !== comment)
            if (thread.comments.length === 0) {
              thread.dispose()
              this.threads.delete(id)
            }
            this.saveComments(thread.uri)
            break
          }
        }
      }),

      vscode.workspace.onDidOpenTextDocument(doc => {
        if (reviewTargetForDocument(this.workspaceRoot, doc.fileName)) {
          this.loadComments(doc.uri)
        }
      }),

      vscode.workspace.onDidSaveTextDocument(doc => {
        if (reviewTargetForDocument(this.workspaceRoot, doc.fileName)) {
          this.saveComments(doc.uri)
        }
      })
    )

    vscode.workspace.textDocuments.forEach(doc => {
      if (reviewTargetForDocument(this.workspaceRoot, doc.fileName)) {
        this.loadComments(doc.uri)
      }
    })
  }

  private normalizePath(filePath: string): string {
    return filePath.replace(/\\/g, '/')
  }

  private isSamePath(left: string, right: string): boolean {
    const normalizedLeft = this.normalizePath(left)
    const normalizedRight = this.normalizePath(right)
    if (process.platform === 'win32') {
      return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    }
    return normalizedLeft === normalizedRight
  }

  private createComment(reply: vscode.CommentReply): void {
    const range = reply.thread.range ?? new vscode.Range(0, 0, 0, 0)
    
    const thread = this.controller.createCommentThread(
      reply.thread.uri,
      range,
      [{
        body: new vscode.MarkdownString(reply.text),
        author: { name: 'You' },
        mode: vscode.CommentMode.Preview
      }]
    )
    thread.canReply = true
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
    
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    this.threads.set(id, thread)
    this.saveComments(reply.thread.uri)
    
    reply.thread.dispose()
  }

  private replyToComment(reply: vscode.CommentReply): void {
    const newComment: vscode.Comment = {
      body: new vscode.MarkdownString(reply.text),
      author: { name: 'You' },
      mode: vscode.CommentMode.Preview
    }
    reply.thread.comments = [...reply.thread.comments, newComment]
    this.saveComments(reply.thread.uri)
  }

  private loadComments(uri: vscode.Uri): void {
    const target = reviewTargetForDocument(this.workspaceRoot, uri.fsPath)
    const commentsPath = target && findReviewCommentsPath(this.workspaceRoot, target)

    this.threads.forEach((thread, id) => {
      if (this.isSamePath(thread.uri.fsPath, uri.fsPath)) {
        thread.dispose()
        this.threads.delete(id)
      }
    })

    if (!commentsPath || !fs.existsSync(commentsPath)) return

    try {
      const data: CommentsFile = JSON.parse(fs.readFileSync(commentsPath, 'utf-8'))

      for (const stored of data.threads) {
        const comments: vscode.Comment[] = [
          {
            body: new vscode.MarkdownString(stored.body),
            author: { name: 'You' },
            mode: vscode.CommentMode.Preview
          },
          ...stored.replies.map(r => ({
            body: new vscode.MarkdownString(r),
            author: { name: 'You' },
            mode: vscode.CommentMode.Preview
          }))
        ]

        const thread = this.controller.createCommentThread(
          uri,
          new vscode.Range(stored.line, 0, stored.line, 0),
          comments
        )
        thread.canReply = true
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded
        
        this.threads.set(stored.id, thread)
      }
    } catch (error) {
      console.error('Failed to load comments:', error)
    }
  }

  private saveComments(uri: vscode.Uri): void {
    const target = reviewTargetForDocument(this.workspaceRoot, uri.fsPath)
    if (!target) return
    const commentsPath = reviewCommentsPath(this.workspaceRoot, target)

    const threads: StoredThread[] = []
    
    this.threads.forEach((thread, id) => {
      if (!this.isSamePath(thread.uri.fsPath, uri.fsPath)) return
      if (thread.comments.length === 0) return

      const [first, ...rest] = thread.comments
      const line = thread.range?.start.line ?? 0
      const getBodyText = (body: string | vscode.MarkdownString): string => 
        typeof body === 'string' ? body : body.value
      threads.push({
        id,
        line,
        body: getBodyText(first.body),
        replies: rest.map(c => getBodyText(c.body))
      })
    })

    const data: CommentsFile = { threads }
    
    try {
      fs.mkdirSync(path.dirname(commentsPath), { recursive: true })
      fs.writeFileSync(commentsPath, JSON.stringify(data, null, 2))
    } catch (error) {
      console.error('Failed to save comments:', error)
    }
  }

  dispose(): void {
    this.commentsWatchers.forEach(watcher => watcher.dispose())
    this.controller.dispose()
  }
}
