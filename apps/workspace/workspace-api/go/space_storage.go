package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net/url"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/aws/signer/v4"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/aws/smithy-go"
)

const partURLLifetime = 10 * time.Minute
const downloadURLLifetime = 5 * time.Minute
const s3Timeout = 15 * time.Second

type spaceStorage struct {
	client *s3.Client
	signer *s3.PresignClient
	bucket string
}

func newSpaceStorage(ctx context.Context, endpoint, bucket, region string) (*spaceStorage, error) {
	origin, err := secureOIDCURL(endpoint, true)
	if err != nil || origin.Path != "" || origin.RawQuery != "" || bucket == "" {
		return nil, errors.New("invalid S3 endpoint or bucket")
	}
	if region == "" {
		region = "us-east-1"
	}
	cfg, err := config.LoadDefaultConfig(ctx, config.WithRegion(region), config.WithRetryMaxAttempts(1))
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(cfg, func(options *s3.Options) {
		options.BaseEndpoint = aws.String(endpoint)
		options.UsePathStyle = true
		options.RequestChecksumCalculation = aws.RequestChecksumCalculationWhenRequired
		options.ResponseChecksumValidation = aws.ResponseChecksumValidationWhenRequired
	})
	signer := s3.NewPresignClient(client, func(options *s3.PresignOptions) {
		options.Presigner = v4.NewSigner(func(options *v4.SignerOptions) {
			options.DisableHeaderHoisting = true
		})
	})
	return &spaceStorage{client: client, signer: signer, bucket: bucket}, nil
}

func spaceObjectKey(id string) string { return "space/" + id }

func storageMissing(err error) bool {
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		switch apiError.ErrorCode() {
		case "NotFound", "NoSuchKey", "NoSuchUpload":
			return true
		}
	}
	return false
}

func (s *spaceStorage) read(ctx context.Context, key string, size int64) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	result, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: &s.bucket, Key: &key})
	if err != nil {
		return nil, err
	}
	defer result.Body.Close()
	if result.ContentLength == nil || *result.ContentLength != size {
		return nil, errors.New("stored file size mismatch")
	}
	data, err := io.ReadAll(io.LimitReader(result.Body, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size {
		return nil, errors.New("stored file size mismatch")
	}
	return data, nil
}

func (s *spaceStorage) create(ctx context.Context, key string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	result, err := s.client.CreateMultipartUpload(ctx, &s3.CreateMultipartUploadInput{
		Bucket: &s.bucket, Key: &key, ChecksumAlgorithm: types.ChecksumAlgorithmSha256,
		ContentType: aws.String("application/octet-stream"),
	})
	if err != nil {
		return "", err
	}
	id := aws.ToString(result.UploadId)
	if id == "" {
		return "", errors.New("missing multipart upload ID")
	}
	return id, nil
}

func (s *spaceStorage) signPart(ctx context.Context, key, upload string, part int32, size int64, checksum string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	signed, err := s.signer.PresignUploadPart(ctx, &s3.UploadPartInput{
		Bucket: &s.bucket, Key: &key, UploadId: &upload, PartNumber: &part,
		ContentLength: &size, ChecksumSHA256: &checksum,
	}, s3.WithPresignExpires(partURLLifetime))
	if err != nil {
		return "", err
	}
	// The browser sends the checksum header and computes Content-Length from the part body.
	if signed.SignedHeader.Get("X-Amz-Checksum-Sha256") != checksum ||
		signed.SignedHeader.Get("Content-Length") == "" {
		return "", errors.New("multipart signature does not bind the checksum and length")
	}
	return signed.URL, nil
}

func (s *spaceStorage) parts(ctx context.Context, key, upload string) ([]types.Part, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	result, err := s.client.ListParts(ctx, &s3.ListPartsInput{Bucket: &s.bucket, Key: &key, UploadId: &upload})
	if storageMissing(err) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	if aws.ToBool(result.IsTruncated) {
		return nil, true, errors.New("unexpected multipart part count")
	}
	return result.Parts, true, nil
}

func (s *spaceStorage) complete(ctx context.Context, key, upload string, parts []types.CompletedPart) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	_, err := s.client.CompleteMultipartUpload(ctx, &s3.CompleteMultipartUploadInput{
		Bucket: &s.bucket, Key: &key, UploadId: &upload, IfNoneMatch: aws.String("*"),
		MultipartUpload: &types.CompletedMultipartUpload{Parts: parts},
	})
	return err
}

func (s *spaceStorage) empty(ctx context.Context, key string) error {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: &s.bucket, Key: &key, Body: bytes.NewReader(nil), ContentLength: aws.Int64(0),
		ContentType: aws.String("application/octet-stream"), IfNoneMatch: aws.String("*"),
	})
	return err
}

func (s *spaceStorage) size(ctx context.Context, key string) (int64, bool, error) {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	result, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: &s.bucket, Key: &key})
	if storageMissing(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if result.ContentLength == nil {
		return 0, false, errors.New("missing object size")
	}
	return *result.ContentLength, true, nil
}

func (s *spaceStorage) remove(ctx context.Context, key string) error {
	deleteCtx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	if _, err := s.client.DeleteObject(deleteCtx, &s3.DeleteObjectInput{Bucket: &s.bucket, Key: &key}); err != nil {
		return err
	}
	if _, exists, err := s.size(ctx, key); err != nil {
		return err
	} else if exists {
		return errors.New("object cleanup pending")
	}
	return nil
}

func (s *spaceStorage) abort(ctx context.Context, key, upload string) error {
	ids := make(map[string]bool)
	if upload != "" {
		ids[upload] = true
	}
	listCtx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	result, err := s.client.ListMultipartUploads(listCtx, &s3.ListMultipartUploadsInput{Bucket: &s.bucket, Prefix: &key})
	if err != nil {
		return err
	}
	if aws.ToBool(result.IsTruncated) {
		return errors.New("unexpected multipart upload count")
	}
	// Find any initiation whose response was lost before the upload ID was recorded.
	for _, item := range result.Uploads {
		id := aws.ToString(item.UploadId)
		if aws.ToString(item.Key) == key && id != "" {
			ids[id] = true
		}
	}
	for id := range ids {
		abortCtx, cancel := context.WithTimeout(ctx, s3Timeout)
		_, err := s.client.AbortMultipartUpload(abortCtx, &s3.AbortMultipartUploadInput{
			Bucket: &s.bucket, Key: &key, UploadId: &id,
		})
		cancel()
		if err != nil && !storageMissing(err) {
			return err
		}
		if _, exists, err := s.parts(ctx, key, id); err != nil {
			return err
		} else if exists {
			return errors.New("multipart cleanup pending")
		}
	}
	return nil
}

func (s *spaceStorage) download(ctx context.Context, key, name string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, s3Timeout)
	defer cancel()
	encoded := strings.ReplaceAll(url.QueryEscape(name), "+", "%20")
	signed, err := s.signer.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: &s.bucket, Key: &key,
		ResponseContentDisposition: aws.String("attachment; filename*=UTF-8''" + encoded),
		ResponseContentType:        aws.String("application/octet-stream"),
	}, s3.WithPresignExpires(downloadURLLifetime))
	if err != nil {
		return "", err
	}
	return signed.URL, nil
}
