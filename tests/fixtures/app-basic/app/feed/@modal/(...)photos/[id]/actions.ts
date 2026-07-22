"use server";

const likesByPhoto = new Map<string, number>();

export async function bumpPhotoLikes(id: string): Promise<number> {
  const next = (likesByPhoto.get(id) ?? 0) + 1;
  likesByPhoto.set(id, next);
  return next;
}

export async function getPhotoLikes(id: string): Promise<number> {
  return likesByPhoto.get(id) ?? 0;
}
