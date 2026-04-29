import fastify from 'fastify';
import fastifyMultipart from '@fastify/multipart';
import { PrismaClient } from '@prisma/client';
import { S3Client, ListBucketsCommand, CreateBucketCommand, PutObjectCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';

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
        console.log(`🔍 Checking if bucket "${process.env.AWS_S3_BUCKET_NAME!}" exists...`);

        if (!process.env.AWS_S3_BUCKET_NAME!) {
            throw new Error("AWS_S3_BUCKET_NAME is missing. Check .env file.");
        }

        const { Buckets } = await s3Client.send(new ListBucketsCommand({}));
        const bucketExists = Buckets?.some((bucket) => bucket.Name === process.env.AWS_S3_BUCKET_NAME!);

        if (bucketExists) {
            console.log(`Bucket "${process.env.AWS_S3_BUCKET_NAME!}" already exists.`);
        } else {
            console.log(`Bucket "${process.env.AWS_S3_BUCKET_NAME!}" not found. Creating...`);
            await s3Client.send(new CreateBucketCommand({ Bucket: process.env.AWS_S3_BUCKET_NAME! }));
            const publicReadOnlyPolicy = {
                Version: "2012-10-17",
                Statement: [
                    {
                        Effect: "Allow",
                        Principal: "*", // Public access (everyone)
                        Action: ["s3:GetObject"], // Allow only reading files
                        Resource: `arn:aws:s3:::${process.env.AWS_S3_BUCKET_NAME!}/*`, // Applies to all objects in the bucket
                    },
                ],
            };

            await s3Client.send(
                new PutBucketPolicyCommand({
                    Bucket: process.env.AWS_S3_BUCKET_NAME!,
                    Policy: JSON.stringify(publicReadOnlyPolicy),
                })
            );
            console.log(`Bucket "${process.env.AWS_S3_BUCKET_NAME!}" created.`);
        }
    } catch (error: any) {
        console.error('Error checking/creating bucket:', error);
        throw error;
    }
};

const server = fastify();
server.register(fastifyMultipart); // Register multipart plugin

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
            return reply.status(400).send({ error: 'No file uploaded' });
        }

        await ensureBucketExists();

        const fileName: string = `${new Date().toISOString()}-${data.filename}`;

        let file: any;
        let fileSize = 0;

        await new Promise((resolve, reject) => {
            data.file.on('data', (chunk: any) => {
                file = file ? Buffer.concat([file, chunk]) : chunk;
                fileSize += chunk.length;
            });

            data.file.on('end', () => {
                console.log(`File size: ${fileSize} bytes`);
                resolve('');
            });
        });

        await s3Client.send(
            new PutObjectCommand({
                Bucket: process.env.AWS_S3_BUCKET_NAME!,
                Key: fileName,
                Body: file,
                ContentType: data.mimetype,
                ContentLength: fileSize,
            })
        );

        const image = await prisma.image.create({
            data: {
                url: `${process.env.AWS_S3_PROTOCOL}://${process.env.AWS_S3_HOST}:${process.env.AWS_S3_PORT}/${process.env.AWS_S3_BUCKET_NAME!}/${fileName}`,
            },
        });
        const count = await prisma.image.count();

        return reply.status(200).send({
            error: null,
            totalItems: count,
            itemsLength: 1,
            data: [image],
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
        const images = await prisma.image.findMany();

        return reply.status(200).send({
            error: null,
            totalItems: images.length,
            itemsLength: images.length,
            data: images,
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

    console.log(`Server listening at ${address}`)
});
