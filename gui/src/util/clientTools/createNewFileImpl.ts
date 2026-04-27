import { throwIfFileIsSecurityConcern } from "core/indexing/ignore";
import { BuiltInToolNames } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import { inferResolvedUriFromRelativePath } from "core/util/ideUtils";
import { getCleanUriPath } from "core/util/uri";
import { v4 as uuid } from "uuid";
import { applyForEditTool } from "../../redux/thunks/handleApplyStateUpdate";
import { ClientToolImpl } from "./callClientTool";

export const createNewFileImpl: ClientToolImpl = async (
  args,
  toolCallId,
  extras,
) => {
  const filepath = args.filepath;
  const contents = args.contents;

  if (!filepath || typeof filepath !== "string" || !filepath.trim()) {
    throw new Error("`filepath` argument is required and must not be empty.");
  }
  if (typeof contents !== "string") {
    throw new Error("`contents` argument is required and must be a string.");
  }

  const resolvedFileUri = await inferResolvedUriFromRelativePath(
    filepath,
    extras.ideMessenger.ide,
  );
  throwIfFileIsSecurityConcern(getCleanUriPath(resolvedFileUri));

  const exists = await extras.ideMessenger.ide.fileExists(resolvedFileUri);
  if (exists) {
    throw new ContinueError(
      ContinueErrorReason.FileAlreadyExists,
      `File ${filepath} already exists. Use the ${BuiltInToolNames.EditExistingFile} tool to edit this file`,
    );
  }

  const streamId = uuid();
  void extras.dispatch(
    applyForEditTool({
      streamId,
      text: contents,
      toolCallId,
      filepath: resolvedFileUri,
    }),
  );

  return {
    respondImmediately: false,
    output: undefined,
  };
};
