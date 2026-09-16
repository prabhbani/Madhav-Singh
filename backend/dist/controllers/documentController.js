import { prisma } from '../config/prisma.js';
import { AppError } from '../errors/AppError.js';
/**
 * Document metadata.
 *
 * `storageKey` is the object-store location of the file. It is never returned:
 * knowing it is a step towards reaching the object outside this API's
 * authorization, so the API reports only whether an object is attached.
 *
 * There is no binary upload endpoint yet. SECURITY.md records the controls that
 * must be in place before one is added.
 */
const documentPublicSelect = {
    id: true,
    projectId: true,
    documentType: true,
    documentReference: true,
    status: true,
    checksumSha256: true,
    submittedAt: true,
    verifiedAt: true,
    createdAt: true,
    updatedAt: true,
};
export const create = async (request, response) => {
    const created = await prisma.document.create({ data: request.body, select: documentPublicSelect });
    response.status(201).json(created);
};
export const get = async (request, response) => {
    const item = await prisma.document.findUnique({
        where: { id: String(request.params.id) },
        select: documentPublicSelect,
    });
    if (!item)
        throw new AppError(404, 'DOCUMENT_NOT_FOUND', 'Document was not found');
    response.json(item);
};
