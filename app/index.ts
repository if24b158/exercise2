import fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import {
    S3Client,
    ListBucketsCommand,
    CreateBucketCommand,
    PutObjectCommand,
    PutBucketPolicyCommand
} from '@aws-sdk/client-s3';
const prisma = new PrismaClient();

const s3Client = new S3Client({
    apiVersion: process.env.AWS_S3_API_VERSION!,
    region: process.env.AWS_S3_REGION!,
    credentials: {
        accessKeyId: process.env.AWS_S3_ACCESS_KEY_ID!,
        secretAccessKey: process.env.AWS_S3_SECRET_ACCESS_KEY!,
    },
    endpoint: `${process.env.AWS_S3_PROTOCOL}://${process.env.AWS_S3_HOST}:${process.env.AWS_S3_PORT}`,
    forcePathStyle: true,
});

const ensureBucketExists = async () => {
    try {
        const bucketName = process.env.AWS_S3_BUCKET_NAME;

        if (!bucketName) {
            throw new Error("AWS_S3_BUCKET_NAME is missing. Check .env file.");
        }

        const { Buckets } = await s3Client.send(new ListBucketsCommand({}));
        const bucketExists = Buckets?.some((bucket) => bucket.Name === bucketName);

        if (!bucketExists) {
            await s3Client.send(
                new CreateBucketCommand({
                    Bucket: bucketName,
                })
            );

            const publicReadOnlyPolicy = {
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Principal: "*",
                        Action: ["s3:GetObject"],
                        Resource: `arn:aws:s3:::${bucketName}/*`,
                    },
                ],
            };

            await s3Client.send(
                new PutBucketPolicyCommand({
                    Bucket: bucketName,
                    Policy: JSON.stringify(publicReadOnlyPolicy),
                })
            );
        }
    } catch (error: any) {
        console.error('Error checking or creating bucket:', error);
        throw error;
    }
};

const server = fastify();

server.register(fastifyMultipart);

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '127.0.0.1';

server.get('/ping', async (_, reply) => {
    try {
        await prisma.counter.create({
            data: {},
        });

        const count = await prisma.counter.count();

        return reply.status(200).send({ count });
    } catch (error: any) {
        return reply.status(500).send({ error: error?.message });
    }
});

server.post('/images', async (request, reply) => {
    try {
        const data = await (request as any).file();

        if (!data) {
            return reply.status(400).send({
                error: 'No file uploaded',
                totalItems: 0,
                itemsLength: 0,
                data: [],
            });
        }

        const allowedMimeTypes = [
            'image/png',
            'image/jpeg',
            'image/jpg',
            'image/webp',
            'image/gif',
        ];

        if (!allowedMimeTypes.includes(data.mimetype)) {
            return reply.status(400).send({
                error: 'Only image files are allowed',
                totalItems: 0,
                itemsLength: 0,
                data: [],
            });
        }

        await ensureBucketExists();

        const safeFileName = data.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
        const fileName = `${Date.now()}-${safeFileName}`;

        const fileBuffer = await data.toBuffer();

        await s3Client.send(
            new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME!,
                Key: fileName,
                Body: fileBuffer,
                ContentType: data.mimetype,
                ContentLength: fileBuffer.length,
            })
        );

        const imagePath = `${process.env.AWS_S3_PROTOCOL}://${process.env.AWS_S3_HOST}:${process.env.AWS_S3_PORT}/${process.env.AWS_S3_BUCKET_NAME!}/${fileName}`;

        const image = await prisma.image.create({
            data: {
                imagePath: imagePath,
            },
        });

        const count = await prisma.image.count();

        return reply.status(200).send({
            error: null,
            totalItems: count,
            itemsLength: 1,
            data: [
                {
                    id: image.id,
                    path: image.imagePath,
                    updated_at: image.uploadedAt,
                },
            ],
        });
    } catch (error: any) {
        console.error('Upload error:', error);

        return reply.status(500).send({
            error: error?.message,
            totalItems: 0,
            itemsLength: 0,
            data: [],
        });
    }
});

server.get('/images', async (_, reply) => {
    try {
        const images = await prisma.image.findMany({
            orderBy: {
                id: 'asc',
            },
        });

        return reply.status(200).send({
            error: null,
            totalItems: images.length,
            itemsLength: images.length,
            data: images.map((image) => ({
                id: image.id,
                path: image.imagePath,
                updated_at: image.uploadedAt,
            })),
        });
    } catch (error: any) {
        console.error('Error fetching images:', error);

        return reply.status(500).send({
            error: error?.message,
            totalItems: 0,
            itemsLength: 0,
            data: [],
        });
    }
});

server.listen({
    host: HOST,
    port: Number(PORT),
}, (err, address) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }

    console.log(`Server listening at ${address}`);
});