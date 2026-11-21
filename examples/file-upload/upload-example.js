// Example for testing file upload
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import FormData from 'form-data';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// API URL
const API_URL = 'http://localhost:3264/api';

/**
 * Uploads a test file to the server
 * @param {string} filePath - Path to the file for upload
 * @returns {Promise<Object>} - File upload result
 */
async function uploadTestFile(filePath) {
    try {
        console.log(`Uploading file: ${filePath}`);

        if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
        }

        // Create FormData for file upload
        const formData = new FormData();
        formData.append('file', fs.createReadStream(filePath));

        // Send upload request
        const response = await axios.post(`${API_URL}/files/upload`, formData, {
            headers: {
                ...formData.getHeaders()
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity
        });

        console.log('File successfully uploaded:');
        console.log(JSON.stringify(response.data, null, 2));

        return response.data;
    } catch (error) {
        console.error('Error uploading file:');
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

/**
 * Gets STS token directly (for testing)
 * @param {Object} fileInfo - File information
 * @returns {Promise<Object>} - STS token data
 */
async function getTestStsToken(fileInfo) {
    try {
        console.log(`Requesting STS token for file: ${fileInfo.filename}`);

        const response = await axios.post(`${API_URL}/files/getstsToken`, fileInfo);

        console.log('STS token received:');
        console.log(JSON.stringify(response.data, null, 2));

        return response.data;
    } catch (error) {
        console.error('Error getting STS token:');
        if (error.response) {
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

/**
 * Directly uploads file via OSS (for testing)
 * @param {string} filePath - Path to file
 * @param {Object} stsData - STS token data
 * @returns {Promise<Object>} - Upload result
 */
async function directUploadFile(filePath, stsData) {
    try {
        console.log(`Direct file upload: ${filePath}`);

        if (!stsData || !stsData.file_url || !stsData.file_path) {
            throw new Error('Invalid STS token data');
        }

        // Load ali-oss library dynamically
        const OSS = (await import('ali-oss')).default;

        // Check for required OSS data
        if (!stsData.access_key_id || !stsData.access_key_secret || !stsData.security_token ||
            !stsData.region || !stsData.bucketname) {
            throw new Error('Incomplete STS token data for OSS');
        }

        console.log(`Creating OSS client: region ${stsData.region}, bucket ${stsData.bucketname}`);

        // Create OSS client with STS token
        const client = new OSS({
            region: stsData.region,
            accessKeyId: stsData.access_key_id,
            accessKeySecret: stsData.access_key_secret,
            stsToken: stsData.security_token,
            bucket: stsData.bucketname,
            secure: true, // Use HTTPS
            timeout: 60000 // 60 seconds timeout
        });

        // Get object name from file_path
        const objectName = stsData.file_path;

        console.log(`Uploading file to OSS: ${objectName}`);

        // Upload file
        const result = await client.put(objectName, filePath);

        console.log('File successfully uploaded to OSS:');
        console.log(`URL: ${stsData.file_url}`);
        console.log(`OSS response: ${JSON.stringify(result)}`);

        // Verify that the file is actually uploaded
        try {
            const verifyResponse = await axios.get(stsData.file_url);
            console.log(`File successfully verified, status: ${verifyResponse.status}`);
        } catch (error) {
            console.log(`Failed to verify file: ${error.message}`);
            // This is not a critical error, as the file may be unavailable immediately
        }

        return {
            success: true,
            fileName: path.basename(filePath),
            url: stsData.file_url,
            fileId: stsData.file_id,
            ossResponse: result
        };
    } catch (error) {
        console.error('Error uploading file to OSS:');
        if (error.response) {
            console.error(`Status: ${error.response.status}`);
            console.error(error.response.data);
        } else {
            console.error(error.message);
        }
        throw error;
    }
}

// Main function to run tests
async function runTest() {
    try {
        // Path to test file (e.g., image)
        const testFilePath = path.join(__dirname, 'test-image.jpg');

        // If file does not exist, create a simple text file for testing
        if (!fs.existsSync(testFilePath)) {
            console.log('Test file not found, creating text file for testing...');

            const textFilePath = path.join(__dirname, 'test-file.txt');
            fs.writeFileSync(textFilePath, 'This is a test file for upload.');

            console.log(`Created test file: ${textFilePath}`);

            // Test getting STS token
            const fileInfo = {
                filename: 'test-file.txt',
                filesize: fs.statSync(textFilePath).size,
                filetype: 'file'
            };

            const stsData = await getTestStsToken(fileInfo);

            // Test direct file upload
            console.log('\n--- Testing direct file upload ---');
            await directUploadFile(textFilePath, stsData);

            // Test upload via API
            console.log('\n--- Testing upload via API ---');
            await uploadTestFile(textFilePath);
        } else {
            // Test getting STS token
            const fileInfo = {
                filename: 'test-image.jpg',
                filesize: fs.statSync(testFilePath).size,
                filetype: 'image'
            };

            const stsData = await getTestStsToken(fileInfo);

            // Test direct file upload
            console.log('\n--- Testing direct file upload ---');
            await directUploadFile(testFilePath, stsData);

            // Test upload via API
            console.log('\n--- Testing upload via API ---');
            await uploadTestFile(testFilePath);
        }

        console.log('\nTesting completed successfully!');
    } catch (error) {
        console.error('Error running tests:', error.message);
    }
}

// Run tests
runTest();
