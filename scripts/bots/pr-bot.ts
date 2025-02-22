import { context as Context, getOctokit } from "@actions/github";
import * as Core from "@actions/core";
import { PullRequestEvent } from "@octokit/webhooks-types";

type API = {
  github: ReturnType<typeof getOctokit>;
  context: typeof Context & {
    payload: PullRequestEvent;
  };
  core: typeof Core;
};

module.exports = async ({ github, context }: API) => {
  const changedFiles: string[] = JSON.parse(process.env.CHANGED_FILES || "[]");
  const codeowners = await getCodeOwners({ github, context });

  const touchedExtensions = new Set(
    changedFiles
      .filter((x) => x.startsWith("extensions"))
      .map((x) => {
        const parts = x.split("/");
        return `/extensions/${parts[1]}`;
      })
  );

  if (touchedExtensions.size > 1) {
    console.log("We only notify people when updating a single extension");
    return;
  }

  const sender = context.payload.sender.login;

  if (sender === "raycastbot") {
    console.log("We don't notify people when raycastbot is doing its stuff (usually merging the PR)");
    return;
  }

  const opts = github.rest.issues.listForRepo.endpoint.merge({
    ...context.issue,
    creator: sender,
    state: "all",
  });
  const issues = await github.paginate<{
    owner: string;
    repo: string;
    number: number;
    pull_request: boolean;
  }>(opts);

  const isFirstContribution = issues.every((issue) => issue.number === context.issue.number || !issue.pull_request);

  for (const ext of touchedExtensions) {
    const owners = codeowners[ext];

    if (!owners) {
      // it's a new extension
      console.log(`cannot find existing extension ${ext}`);
      await github.rest.issues.addLabels({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        labels: ["new extension"],
      });
      await comment({
        github,
        context,
        comment: `Congratulation on your new Raycast extension! :rocket:\n\nWe will review it shortly. Once the PR is approved and merged, the extension will be available on the Store.`,
      });
      return;
    }

    await github.rest.issues.addLabels({
      issue_number: context.issue.number,
      owner: context.repo.owner,
      repo: context.repo.repo,
      labels: [
        "extension fix / improvement",
        limitLabelLength(`extension: ${await findExtensionName(ext, { github, context })}`),
      ],
    });

    if (owners[0] === sender) {
      await github.rest.issues.addLabels({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        labels: ["OP is author"],
      });
      return;
    }

    if (owners.indexOf(sender) !== -1) {
      await github.rest.issues.addLabels({
        issue_number: context.issue.number,
        owner: context.repo.owner,
        repo: context.repo.repo,
        labels: ["OP is contributor"],
      });
    }

    await comment({
      github,
      context,
      comment: `Thank you for your ${isFirstContribution ? "first " : ""} contribution! :tada:\n\n🔔 ${owners
        .filter((x) => x !== sender)
        .map((x) => `@${x}`)
        .join(" ")} you might want to have a look.`,
    });

    return;
  }
};

async function getCodeOwners({ github, context }: Pick<API, "github" | "context">) {
  const codeowners = await getGitHubFile(".github/CODEOWNERS", { github, context });

  const regex = /(\/extensions\/[\w-]+) +(.+)/g;
  const matches = codeowners.matchAll(regex);

  return Array.from(matches).reduce<{ [key: string]: string[] }>((prev, match) => {
    prev[match[1]] = match[2].split(" ").map((x) => x.replace(/^@/, ""));
    return prev;
  }, {});
}

async function getExtensionName2Folder({ github, context }: Pick<API, "github" | "context">) {
  const file = await getGitHubFile(".github/extensionName2Folder.json", { github, context });
  return JSON.parse(file) as { [key: string]: string };
}

async function getGitHubFile(path: string, { github, context }: Pick<API, "github" | "context">) {
  const { data } = await github.rest.repos.getContent({
    mediaType: {
      format: "raw",
    },
    owner: context.repo.owner,
    repo: context.repo.repo,
    path,
  });

  // @ts-ignore
  return data as string;
}

// Create a new comment or update the existing one
async function comment({ github, context, comment }: Pick<API, "github" | "context"> & { comment: string }) {
  // Get the existing comments on the PR
  const { data: comments } = await github.rest.issues.listComments({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
  });

  // Find any comment already made by the bot
  const botComment = comments.find((comment) => comment.user?.login === "raycastbot");

  if (botComment) {
    await github.rest.issues.updateComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      comment_id: botComment.id,
      body: comment,
    });
  } else {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body: comment,
    });
  }
}

function limitLabelLength(label: string) {
  return label.length > 50 ? label.substring(0, 49) + "…" : label;
}

async function findExtensionName(ext: string, api: Pick<API, "github" | "context">) {
  const map = await getExtensionName2Folder(api);

  const folder = ext.replace("/extensions/", "");

  const foundExtension = Object.entries(map).find(([name, _folder]) => _folder === folder);

  return foundExtension ? foundExtension[0] : undefined;
}
